"""Deterministic, incremental arXiv HTML harvesting for map maintenance.

This module deliberately uses the public arXiv web pages rather than the
Atom/API endpoints.  It performs only sequential requests, maintains an
HTTP validator cache, and emits parsed JSON rather than raw HTML.  The parser
is intentionally strict: a changed or partial page stops the coverage run
instead of silently advancing its cursor.

The module can be used directly by the maintenance orchestrator::

    bundle = harvest(config, client=client, ledger=ledger, run_id=run_id)

or as a small standalone command::

    python3 -m scripts.maintenance.harvest --config harvest.json \
        --cache-dir /path/to/cache --output candidates.json
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import email.utils
import hashlib
import html.parser
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .ledger import Ledger, canonical_json, normalize_arxiv_id, sha256_bytes


BUNDLE_SCHEMA_VERSION = 1
DEFAULT_USER_AGENT = (
    "LZ-paper-map-maintainer/1.0 "
    "(+https://davidcyncynates.github.io/lz-paper-map/)"
)
_ALLOWED_HOSTS = frozenset(("arxiv.org", "www.arxiv.org"))
_ALLOWED_PATH_PREFIXES = ("/abs/", "/html/", "/list/", "/search/")
_VOID_ELEMENTS = frozenset(
    (
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    )
)
_RETRYABLE_STATUS = frozenset((429, 500, 502, 503, 504))
_SPACE = re.compile(r"\s+")
_ARXIV_IN_PATH = re.compile(
    r"(?i)(?:^|/)(?:abs/)?((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.\-]+/\d{7})(?:v\d+)?)$"
)
_SECTION_PATTERNS = (
    ("new", re.compile(r"^new submissions?\b", re.I)),
    ("cross", re.compile(r"^cross[- ]?lists?\b", re.I)),
    ("replacement", re.compile(r"^replacements?\b", re.I)),
)
_INCOMPLETE_SECTION = re.compile(
    r"showing\s+(?:first\s+)?(\d+)\s+of\s+(\d+)\s+entr", re.I
)
_TOTAL_ENTRIES = re.compile(r"total\s+of\s+(\d+)\s+entr", re.I)
_DATE_PATTERNS = (
    re.compile(r"showing new listings for\s+(.+)$", re.I),
    re.compile(
        r"^((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|"
        r"Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+"
        r"\d{1,2}\s+[A-Za-z]+\s+\d{4})\b",
        re.I,
    ),
)
_VERSION_DATE = re.compile(
    r"\[v(?P<version>\d+)\]\s*"
    r"(?P<date>(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?"
    r"\d{1,2}\s+[A-Za-z]+\s+\d{4}"
    r"(?:\s+\d{1,2}:\d{2}:\d{2}\s+(?:UTC|GMT))?)",
    re.I,
)


class HarvestError(RuntimeError):
    """Raised when source coverage cannot be proved complete."""


class ParseError(HarvestError):
    """Raised when an arXiv HTML page is malformed or unexpectedly changed."""


def _clean_text(value: str) -> str:
    return _SPACE.sub(" ", value).strip()


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    temporary.replace(path)


def _validate_public_html_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in _ALLOWED_HOSTS:
        raise ValueError(f"only public https://arxiv.org HTML URLs are allowed: {url!r}")
    if not any(parsed.path.startswith(prefix) for prefix in _ALLOWED_PATH_PREFIXES):
        raise ValueError(f"unsupported arXiv HTML path: {parsed.path!r}")
    if parsed.path.startswith(("/api/", "/export/")):
        raise ValueError("arXiv API endpoints are not allowed")
    return urllib.parse.urlunsplit(parsed)


def _arxiv_id_from_href(href: str) -> str | None:
    parsed = urllib.parse.urlsplit(href)
    match = _ARXIV_IN_PATH.search(parsed.path.rstrip("/"))
    if match is None:
        return None
    try:
        return normalize_arxiv_id(match.group(1))[0]
    except ValueError:
        return None


def _parse_date(raw: str) -> str | None:
    candidate = _clean_text(raw).rstrip(".:")
    candidate = re.sub(
        r"^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|"
        r"Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+",
        "",
        candidate,
        flags=re.I,
    )
    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return dt.datetime.strptime(candidate, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _parse_submission_datetime(raw: str) -> str:
    normalized = re.sub(r"\bUTC\b", "+0000", _clean_text(raw), flags=re.I)
    normalized = re.sub(r"\bGMT\b", "+0000", normalized, flags=re.I)
    parsed = email.utils.parsedate_to_datetime(normalized)
    if parsed is None:
        raise ParseError(f"could not parse submission-history date {raw!r}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


class _TextHTMLParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.all_text: list[str] = []

    def handle_data(self, data: str) -> None:
        self.all_text.append(data)


@dataclasses.dataclass(frozen=True)
class ListingBatch:
    source: str
    batch_key: str
    announcement_date: str
    section: str
    ids: tuple[str, ...]

    def as_json(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "batchKey": self.batch_key,
            "announcementDate": self.announcement_date,
            "section": self.section,
            "idCount": len(self.ids),
            "ids": list(self.ids),
        }


class _ListingParser(_TextHTMLParser):
    def __init__(self, source: str) -> None:
        super().__init__()
        self.source = source
        self._heading_tag: str | None = None
        self._heading_text: list[str] = []
        self.current_date: str | None = None
        self.dates_seen: list[str] = []
        self.current_section: str | None = None
        self.entries: list[tuple[str, str, str]] = []
        self.section_claims: list[tuple[int, int, str]] = []
        self._saw_article_container = False
        self._depth = 0
        self._articles_depth: int | None = None
        self._entry_depth: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID_ELEMENTS:
            self._depth += 1
        attributes = {key.lower(): value or "" for key, value in attrs}
        if tag in ("h2", "h3", "h4"):
            self._heading_tag = tag
            self._heading_text = []
        element_id = attributes.get("id", "")
        element_class = set(attributes.get("class", "").split())
        if element_id == "articles" or "articles" in element_class:
            self._saw_article_container = True
            self._articles_depth = self._depth
        if tag == "dt" and self._articles_depth is not None:
            self._entry_depth = self._depth
        if tag == "a" and self._entry_depth is not None:
            identifier = _arxiv_id_from_href(attributes.get("href", ""))
            if identifier and self.current_date:
                section = self.current_section or "recent"
                self.entries.append((self.current_date, section, identifier))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_ELEMENTS:
            return
        if tag == self._heading_tag:
            heading = _clean_text(" ".join(self._heading_text))
            self._consume_heading(heading)
            self._heading_tag = None
            self._heading_text = []
        if self._entry_depth == self._depth:
            self._entry_depth = None
        if self._articles_depth == self._depth:
            self._articles_depth = None
        self._depth = max(0, self._depth - 1)

    def handle_data(self, data: str) -> None:
        super().handle_data(data)
        if self._heading_tag:
            self._heading_text.append(data)

    def _consume_heading(self, heading: str) -> None:
        for pattern in _DATE_PATTERNS:
            match = pattern.search(heading)
            if match:
                parsed = _parse_date(match.group(1))
                if parsed is None:
                    raise ParseError(f"unrecognized listing date heading: {heading!r}")
                self.current_date = parsed
                if parsed not in self.dates_seen:
                    self.dates_seen.append(parsed)
                # Recent pages use one date per heading and have no subsection.
                if not heading.lower().startswith("showing new listings"):
                    self.current_section = "recent"
                return
        for section, pattern in _SECTION_PATTERNS:
            if pattern.search(heading):
                self.current_section = section
                claim = _INCOMPLETE_SECTION.search(heading)
                if claim:
                    self.section_claims.append(
                        (int(claim.group(1)), int(claim.group(2)), heading)
                    )
                return


def parse_listing_page(html: str, *, source: str) -> list[ListingBatch]:
    """Parse a complete ``/list/...`` page into immutable date/section batches."""

    parser = _ListingParser(source)
    try:
        parser.feed(html)
        parser.close()
    except html_parser_errors() as error:
        raise ParseError(f"invalid listing HTML: {error}") from error

    text = _clean_text(" ".join(parser.all_text))
    total_match = _TOTAL_ENTRIES.search(text)
    if not parser.entries and total_match and int(total_match.group(1)) == 0:
        if not parser.dates_seen:
            raise ParseError("zero-entry listing has no parseable announcement date")
        if source.endswith(":recent"):
            section = "recent"
        elif source.endswith(":new"):
            section = "new"
        else:
            section = parser.current_section or "listing"
        return [
            ListingBatch(source, f"{date}:{section}", date, section, ())
            for date in sorted(parser.dates_seen)
        ]
    if not parser._saw_article_container:
        raise ParseError("listing page has no #articles container")
    for shown, total, heading in parser.section_claims:
        if shown < total:
            raise ParseError(f"listing is partial ({shown} of {total}): {heading}")
    if not parser.entries:
        raise ParseError("listing page has no parseable arXiv entries")

    grouped: dict[tuple[str, str], list[str]] = {}
    for announcement_date, section, identifier in parser.entries:
        values = grouped.setdefault((announcement_date, section), [])
        if identifier not in values:
            values.append(identifier)

    unique_ids = {identifier for _date, _section, identifier in parser.entries}
    if total_match and int(total_match.group(1)) != len(unique_ids):
        raise ParseError(
            "listing entry count mismatch: "
            f"page claims {total_match.group(1)}, parsed {len(unique_ids)}"
        )

    batches = []
    for (announcement_date, section), ids in sorted(grouped.items()):
        batch_key = f"{announcement_date}:{section}"
        batches.append(
            ListingBatch(source, batch_key, announcement_date, section, tuple(ids))
        )
    return batches


def html_parser_errors() -> tuple[type[Exception], ...]:
    # HTMLParser is deliberately forgiving and normally raises only ValueError
    # for malformed character references.  Keeping this helper makes the
    # fail-closed boundary explicit and easy to extend.
    return (ValueError, AssertionError)


class _AbstractParser(_TextHTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, list[str]] = {}
        self.canonical: str | None = None
        self._captures: list[tuple[str, str, list[str]]] = []
        self.captured: dict[str, list[str]] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value or "" for key, value in attrs}
        if tag == "meta":
            key = (attributes.get("name") or attributes.get("property") or "").lower()
            content = attributes.get("content", "")
            if key and content:
                self.meta.setdefault(key, []).append(content)
        if tag == "link" and "canonical" in attributes.get("rel", "").lower().split():
            self.canonical = attributes.get("href") or self.canonical

        classes = set(attributes.get("class", "").split())
        capture: str | None = None
        if tag == "h1" and "title" in classes:
            capture = "title"
        elif tag == "div" and "authors" in classes:
            capture = "authors"
        elif tag == "blockquote" and "abstract" in classes:
            capture = "abstract"
        elif tag == "div" and "dateline" in classes:
            capture = "dateline"
        elif tag == "div" and "submission-history" in classes:
            capture = "history"
        if capture:
            self._captures.append((capture, tag, []))

    def handle_endtag(self, tag: str) -> None:
        if self._captures and self._captures[-1][1] == tag:
            name, _tag, values = self._captures.pop()
            self.captured.setdefault(name, []).append(_clean_text(" ".join(values)))

    def handle_data(self, data: str) -> None:
        super().handle_data(data)
        for _name, _tag, values in self._captures:
            values.append(data)


def _first_meta(meta: Mapping[str, list[str]], *names: str) -> str | None:
    for name in names:
        values = meta.get(name.lower())
        if values:
            return _clean_text(values[0])
    return None


def _descriptorless(value: str, descriptor: str) -> str:
    return re.sub(rf"^{re.escape(descriptor)}\s*:\s*", "", value, flags=re.I).strip()


def parse_abstract_page(html: str, *, expected_id: str | None = None) -> dict[str, Any]:
    """Return canonical metadata and complete version history from an abs page."""

    parser = _AbstractParser()
    try:
        parser.feed(html)
        parser.close()
    except html_parser_errors() as error:
        raise ParseError(f"invalid abstract HTML: {error}") from error

    raw_id = _first_meta(parser.meta, "citation_arxiv_id")
    if raw_id is None and parser.canonical:
        raw_id = _arxiv_id_from_href(parser.canonical)
    if raw_id is None:
        raise ParseError("abstract page is missing citation_arxiv_id/canonical URL")
    try:
        identifier = normalize_arxiv_id(raw_id)[0]
    except ValueError as error:
        raise ParseError(f"invalid arXiv ID in abstract page: {raw_id!r}") from error
    if expected_id is not None and identifier != normalize_arxiv_id(expected_id)[0]:
        raise ParseError(
            f"abstract identity mismatch: expected {expected_id!r}, received {identifier!r}"
        )

    title = _first_meta(parser.meta, "citation_title")
    if title is None and parser.captured.get("title"):
        title = _descriptorless(parser.captured["title"][0], "Title")
    authors = [_clean_text(value) for value in parser.meta.get("citation_author", [])]
    if not authors and parser.captured.get("authors"):
        raw_authors = _descriptorless(parser.captured["authors"][0], "Authors")
        authors = [_clean_text(value) for value in raw_authors.split(",") if _clean_text(value)]
    abstract = _first_meta(parser.meta, "citation_abstract", "og:description")
    if abstract is None and parser.captured.get("abstract"):
        abstract = _descriptorless(parser.captured["abstract"][0], "Abstract")
    if not title or not authors or not abstract:
        missing = [
            name
            for name, value in (("title", title), ("authors", authors), ("abstract", abstract))
            if not value
        ]
        raise ParseError(f"abstract page is missing required metadata: {', '.join(missing)}")

    history_text = " ".join(parser.captured.get("history", []))
    history: list[dict[str, Any]] = []
    for match in _VERSION_DATE.finditer(history_text):
        history.append(
            {
                "version": int(match.group("version")),
                "submittedAt": _parse_submission_datetime(match.group("date")),
            }
        )
    versions = [item["version"] for item in history]
    if not history or versions != list(range(1, max(versions) + 1)):
        raise ParseError("abstract page has missing or non-contiguous submission history")
    version = max(versions)
    latest = next(item for item in history if item["version"] == version)
    first = next(item for item in history if item["version"] == 1)

    subjects = []
    for value in parser.meta.get("citation_keywords", []):
        subjects.extend(part.strip() for part in value.split(";") if part.strip())
    primary_category = _first_meta(parser.meta, "citation_primary_category")
    metadata: dict[str, Any] = {
        "arxivId": identifier,
        "version": version,
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "submitted": first["submittedAt"][:10],
        "updated": latest["submittedAt"][:10],
        "history": history,
        "sourceUrl": f"https://arxiv.org/abs/{identifier}",
    }
    if primary_category:
        metadata["primaryCategory"] = primary_category
    if subjects:
        metadata["subjects"] = sorted(set(subjects))
    return metadata


@dataclasses.dataclass(frozen=True)
class SearchPage:
    ids: tuple[str, ...]
    next_url: str | None
    total_results: int | None


class _SearchParser(_TextHTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self._result_depth = 0
        self._depth = 0
        self.saw_results = False
        self.ids: list[str] = []
        self.next_url: str | None = None
        self.total_results: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID_ELEMENTS:
            self._depth += 1
        attributes = {key.lower(): value or "" for key, value in attrs}
        classes = set(attributes.get("class", "").split())
        if tag == "li" and "arxiv-result" in classes:
            self.saw_results = True
            self._result_depth = self._depth
        if tag == "a":
            if self._result_depth:
                identifier = _arxiv_id_from_href(attributes.get("href", ""))
                if identifier and identifier not in self.ids:
                    self.ids.append(identifier)
            if "pagination-next" in classes and attributes.get("href"):
                self.next_url = urllib.parse.urljoin(self.base_url, attributes["href"])

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_ELEMENTS:
            return
        if self._result_depth == self._depth and tag == "li":
            self._result_depth = 0
        self._depth = max(0, self._depth - 1)

    def handle_data(self, data: str) -> None:
        super().handle_data(data)
        match = re.search(r"([\d,]+)\s+results?\s+for", data, flags=re.I)
        if match:
            self.total_results = int(match.group(1).replace(",", ""))


def parse_search_page(html: str, *, url: str) -> SearchPage:
    """Parse one newest-first arXiv HTML search page."""

    parser = _SearchParser(url)
    try:
        parser.feed(html)
        parser.close()
    except html_parser_errors() as error:
        raise ParseError(f"invalid search HTML: {error}") from error
    text = _clean_text(" ".join(parser.all_text))
    if not parser.saw_results:
        if re.search(r"(?:0|no)\s+results?", text, flags=re.I):
            return SearchPage((), None, 0)
        # arXiv redirects an exact-ID search straight to that paper's abstract
        # page.  Accept only a query that itself normalizes to the same exact
        # arXiv identity, and run the full strict abstract parser before
        # treating it as a one-row search result.
        query_values = urllib.parse.parse_qs(
            urllib.parse.urlsplit(url).query
        ).get("query", [])
        if len(query_values) == 1:
            try:
                identifier = normalize_arxiv_id(query_values[0])[0]
            except ValueError:
                identifier = None
            if identifier is not None:
                metadata = parse_abstract_page(html, expected_id=identifier)
                return SearchPage((metadata["arxivId"],), None, 1)
        raise ParseError("search page has no .arxiv-result entries")
    if not parser.ids:
        raise ParseError("search result containers contain no arXiv IDs")
    if parser.total_results is not None and parser.total_results < len(parser.ids):
        raise ParseError("search page parsed more rows than its stated total")
    return SearchPage(tuple(parser.ids), parser.next_url, parser.total_results)


def split_at_frontier(
    ids: Sequence[str], frontier: Iterable[str]
) -> tuple[list[str], bool]:
    """Return newest IDs before the first committed frontier ID."""

    normalized_frontier = {normalize_arxiv_id(value)[0] for value in frontier}
    if not normalized_frontier:
        return list(dict.fromkeys(ids)), False
    unseen: list[str] = []
    for raw in ids:
        identifier = normalize_arxiv_id(raw)[0]
        if identifier in normalized_frontier:
            return unseen, True
        if identifier not in unseen:
            unseen.append(identifier)
    return unseen, False


@dataclasses.dataclass
class FetchMetrics:
    logical_requests: int = 0
    network_requests: int = 0
    fresh_cache_hits: int = 0
    not_modified_hits: int = 0
    memory_hits: int = 0
    retries: int = 0
    bytes_downloaded: int = 0

    def as_json(self) -> dict[str, int]:
        return {
            "logicalRequests": self.logical_requests,
            "networkRequests": self.network_requests,
            "freshCacheHits": self.fresh_cache_hits,
            "notModifiedHits": self.not_modified_hits,
            "memoryHits": self.memory_hits,
            "retries": self.retries,
            "bytesDownloaded": self.bytes_downloaded,
        }


@dataclasses.dataclass(frozen=True)
class FetchResult:
    url: str
    body: bytes
    content_sha256: str
    cache_status: str
    etag: str | None = None
    last_modified: str | None = None

    def text(self) -> str:
        try:
            return self.body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ParseError(f"arXiv page is not valid UTF-8: {self.url}") from error


class CachedHttpClient:
    """Polite sequential HTTP client with validator-backed disk caching."""

    def __init__(
        self,
        cache_dir: str | os.PathLike[str],
        *,
        delay_seconds: float = 3.0,
        retries: int = 3,
        timeout_seconds: float = 30.0,
        cache_max_age_seconds: float = 0.0,
        user_agent: str = DEFAULT_USER_AGENT,
        max_response_bytes: int = 12_000_000,
        opener: Callable[..., Any] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if delay_seconds < 0 or retries < 0 or cache_max_age_seconds < 0:
            raise ValueError("delay, retries, and cache max-age cannot be negative")
        if not user_agent.strip():
            raise ValueError("a descriptive User-Agent is required")
        self.cache_dir = Path(cache_dir).expanduser().resolve()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.delay_seconds = delay_seconds
        self.retries = retries
        self.timeout_seconds = timeout_seconds
        self.cache_max_age_seconds = cache_max_age_seconds
        self.user_agent = user_agent
        self.max_response_bytes = max_response_bytes
        self._opener = opener or urllib.request.urlopen
        self._sleep = sleep
        self._clock = clock
        self._next_request_at = 0.0
        self._memory: dict[str, FetchResult] = {}
        self.metrics = FetchMetrics()

    def _paths(self, url: str) -> tuple[Path, Path]:
        key = _sha256_text(url)
        return self.cache_dir / f"{key}.html", self.cache_dir / f"{key}.json"

    def _read_cache(self, url: str) -> tuple[bytes, dict[str, Any]] | None:
        body_path, meta_path = self._paths(url)
        if not body_path.is_file() or not meta_path.is_file():
            return None
        try:
            body = body_path.read_bytes()
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # A cache is an optimization, never coverage evidence.  An
            # interrupted write is safely repaired by a fresh network fetch.
            return None
        if metadata.get("url") != url or metadata.get("sha256") != sha256_bytes(body):
            return None
        return body, metadata

    def _write_cache(
        self, url: str, body: bytes, headers: Mapping[str, str], final_url: str
    ) -> dict[str, Any]:
        body_path, meta_path = self._paths(url)
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        metadata = {
            "schemaVersion": 1,
            "url": url,
            "finalUrl": final_url,
            "sha256": sha256_bytes(body),
            "etag": headers.get("ETag") or headers.get("etag"),
            "lastModified": headers.get("Last-Modified") or headers.get("last-modified"),
            "contentType": headers.get("Content-Type") or headers.get("content-type"),
            "fetchedAt": now.isoformat().replace("+00:00", "Z"),
            "fetchedEpoch": now.timestamp(),
        }
        _atomic_write(body_path, body)
        _atomic_write(
            meta_path,
            (canonical_json(metadata) + "\n").encode("utf-8"),
        )
        return metadata

    def _result(
        self, url: str, body: bytes, metadata: Mapping[str, Any], status: str
    ) -> FetchResult:
        result = FetchResult(
            url=url,
            body=body,
            content_sha256=sha256_bytes(body),
            cache_status=status,
            etag=metadata.get("etag"),
            last_modified=metadata.get("lastModified"),
        )
        self._memory[url] = result
        return result

    def _wait_for_slot(self) -> None:
        wait = self._next_request_at - self._clock()
        if wait > 0:
            self._sleep(wait)

    def fetch(self, url: str) -> FetchResult:
        url = _validate_public_html_url(url)
        self.metrics.logical_requests += 1
        if url in self._memory:
            self.metrics.memory_hits += 1
            cached = self._memory[url]
            return dataclasses.replace(cached, cache_status="memory")

        cached = self._read_cache(url)
        if cached is not None and self.cache_max_age_seconds > 0:
            body, metadata = cached
            age = time.time() - float(metadata.get("fetchedEpoch", 0))
            if 0 <= age <= self.cache_max_age_seconds:
                self.metrics.fresh_cache_hits += 1
                return self._result(url, body, metadata, "fresh")

        headers = {"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml"}
        if cached is not None:
            _body, metadata = cached
            if metadata.get("etag"):
                headers["If-None-Match"] = str(metadata["etag"])
            if metadata.get("lastModified"):
                headers["If-Modified-Since"] = str(metadata["lastModified"])

        for attempt in range(self.retries + 1):
            self._wait_for_slot()
            request = urllib.request.Request(url, headers=headers, method="GET")
            self.metrics.network_requests += 1
            try:
                response = self._opener(request, timeout=self.timeout_seconds)
                with response:
                    final_url = _validate_public_html_url(response.geturl())
                    content_type = response.headers.get("Content-Type", "")
                    if "text/html" not in content_type.lower():
                        raise HarvestError(
                            f"expected text/html from {url}, received {content_type!r}"
                        )
                    body = response.read(self.max_response_bytes + 1)
                    if len(body) > self.max_response_bytes:
                        raise HarvestError(f"response exceeds size limit for {url}")
                    if not body.strip():
                        raise HarvestError(f"empty HTML response from {url}")
                    metadata = self._write_cache(url, body, response.headers, final_url)
                    self.metrics.bytes_downloaded += len(body)
                    return self._result(url, body, metadata, "network")
            except urllib.error.HTTPError as error:
                if error.code == 304:
                    if cached is None:
                        raise HarvestError(f"received 304 without a cache entry for {url}") from error
                    body, metadata = cached
                    self.metrics.not_modified_hits += 1
                    # Refresh only the validation time; the immutable body remains unchanged.
                    refreshed = dict(metadata)
                    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
                    refreshed["fetchedAt"] = now.isoformat().replace("+00:00", "Z")
                    refreshed["fetchedEpoch"] = now.timestamp()
                    _body_path, meta_path = self._paths(url)
                    _atomic_write(
                        meta_path,
                        (canonical_json(refreshed) + "\n").encode("utf-8"),
                    )
                    return self._result(url, body, refreshed, "not_modified")
                if error.code not in _RETRYABLE_STATUS or attempt >= self.retries:
                    raise HarvestError(f"HTTP {error.code} while fetching {url}") from error
                retry_after = error.headers.get("Retry-After") if error.headers else None
                backoff = min(60.0, float(retry_after)) if retry_after and retry_after.isdigit() else min(60.0, 2.0**attempt)
                self.metrics.retries += 1
                self._sleep(backoff)
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if attempt >= self.retries:
                    raise HarvestError(f"network failure while fetching {url}: {error}") from error
                self.metrics.retries += 1
                self._sleep(min(60.0, 2.0**attempt))
            finally:
                self._next_request_at = self._clock() + self.delay_seconds
        raise AssertionError("unreachable retry loop")


@dataclasses.dataclass(frozen=True)
class ListingSource:
    name: str
    url: str


@dataclasses.dataclass(frozen=True)
class SearchSource:
    name: str
    url: str
    frontier: tuple[str, ...]
    max_pages: int = 4
    exhaustive: bool = False


@dataclasses.dataclass(frozen=True)
class HarvestConfig:
    listings: tuple[ListingSource, ...]
    searches: tuple[SearchSource, ...]
    explicit_ids: tuple[str, ...] = ()
    known_versions: tuple[tuple[str, int], ...] = ()
    review_limit: int = 500
    include_due_authors: bool = False
    author_limit: int = 8
    overlap_days: int = 2
    coverage_through: str | None = None
    expected_latest_date: str | None = None

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> "HarvestConfig":
        if value.get("schemaVersion", 1) != 1:
            raise ValueError("unsupported harvest-config schemaVersion")
        listings = tuple(
            ListingSource(str(item["name"]), _validate_public_html_url(str(item["url"])))
            for item in value.get("listings", [])
        )
        searches = tuple(
            SearchSource(
                str(item["name"]),
                _validate_public_html_url(str(item["url"])),
                tuple(normalize_arxiv_id(raw)[0] for raw in item.get("frontier", [])),
                int(item.get("maxPages", 4)),
                bool(item.get("exhaustive", False)),
            )
            for item in value.get("searches", [])
        )
        if any(search.max_pages <= 0 for search in searches):
            raise ValueError("search maxPages must be positive")
        known_versions = []
        for raw, version in value.get("knownVersions", {}).items():
            identifier = normalize_arxiv_id(str(raw))[0]
            parsed_version = int(version)
            if parsed_version <= 0:
                raise ValueError("known versions must be positive")
            known_versions.append((identifier, parsed_version))
        explicit = tuple(
            sorted({normalize_arxiv_id(str(raw))[0] for raw in value.get("explicitIds", [])})
        )
        review_limit = int(value.get("reviewLimit", 500))
        author_limit = int(value.get("authorLimit", 8))
        overlap_days = int(value.get("overlapDays", 2))
        coverage_through = value.get("coverageThrough")
        if coverage_through is not None:
            dt.date.fromisoformat(str(coverage_through))
            coverage_through = str(coverage_through)
        expected_latest_date = value.get("expectedLatestDate")
        if expected_latest_date is not None:
            dt.date.fromisoformat(str(expected_latest_date))
            expected_latest_date = str(expected_latest_date)
        if review_limit <= 0 or author_limit < 0 or overlap_days < 0:
            raise ValueError(
                "reviewLimit must be positive; authorLimit/overlapDays must be non-negative"
            )
        return cls(
            listings=tuple(sorted(listings, key=lambda item: item.name)),
            searches=tuple(sorted(searches, key=lambda item: item.name)),
            explicit_ids=explicit,
            known_versions=tuple(sorted(known_versions)),
            review_limit=review_limit,
            include_due_authors=bool(value.get("includeDueAuthors", False)),
            author_limit=author_limit,
            overlap_days=overlap_days,
            coverage_through=coverage_through,
            expected_latest_date=expected_latest_date,
        )


def _frontier_from_cursor(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, dict):
        value = value.get("frontier", [])
    if not isinstance(value, list):
        raise HarvestError("committed search cursor must be an array or {frontier: array}")
    try:
        return tuple(normalize_arxiv_id(str(raw))[0] for raw in value)
    except ValueError as error:
        raise HarvestError(f"committed search cursor contains an invalid arXiv ID: {error}") from error


def _require_newest_first(url: str) -> None:
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    if query.get("order") != ["-announced_date_first"]:
        raise HarvestError(
            "incremental arXiv searches must use order=-announced_date_first: " + url
        )


def _author_search_url(author: str) -> str:
    query = urllib.parse.urlencode(
        {
            "query": author,
            "searchtype": "author",
            "abstracts": "show",
            "order": "-announced_date_first",
            "size": "50",
        }
    )
    return "https://arxiv.org/search/?" + query


def _search_pages(
    source: SearchSource,
    client: CachedHttpClient,
) -> tuple[list[dict[str, Any]], list[str], bool, bool]:
    _require_newest_first(source.url)
    pages: list[dict[str, Any]] = []
    all_new: list[str] = []
    frontier_reached = False
    exhausted = False
    next_url: str | None = source.url
    stated_total: int | None = None
    paged_ids: set[str] = set()
    for page_number in range(1, source.max_pages + 1):
        if next_url is None:
            exhausted = True
            break
        _require_newest_first(next_url)
        fetched = client.fetch(next_url)
        parsed = parse_search_page(fetched.text(), url=next_url)
        if parsed.total_results is None:
            raise HarvestError(
                f"search {source.name!r} page {page_number} has no stated result total"
            )
        if stated_total is None:
            stated_total = parsed.total_results
        elif parsed.total_results != stated_total:
            raise HarvestError(
                f"search {source.name!r} changed its stated result total across pages"
            )
        duplicate_page_ids = paged_ids.intersection(parsed.ids)
        if duplicate_page_ids:
            raise HarvestError(
                f"search {source.name!r} repeated IDs across pages: "
                + ", ".join(sorted(duplicate_page_ids)[:5])
            )
        paged_ids.update(parsed.ids)
        new_ids, page_frontier = split_at_frontier(parsed.ids, source.frontier)
        for identifier in new_ids:
            if identifier not in all_new:
                all_new.append(identifier)
        pages.append(
            {
                "page": page_number,
                "url": next_url,
                "contentSha256": fetched.content_sha256,
                "cacheStatus": fetched.cache_status,
                "ids": list(parsed.ids),
                "idCount": len(parsed.ids),
                "totalResults": parsed.total_results,
                "newIds": new_ids,
            }
        )
        if page_frontier:
            frontier_reached = True
            break
        next_url = parsed.next_url
        if next_url is None:
            exhausted = True
            break
    if exhausted and stated_total is not None and len(paged_ids) != stated_total:
        raise HarvestError(
            f"search {source.name!r} exhausted after {len(paged_ids)} unique IDs, "
            f"but the page states {stated_total} results"
        )
    if not frontier_reached and not exhausted:
        raise HarvestError(
            f"search {source.name!r} reached maxPages={source.max_pages} before its frontier"
        )
    if source.frontier and not frontier_reached and not source.exhaustive:
        raise HarvestError(
            f"search {source.name!r} exhausted results before reaching its committed frontier"
        )
    return pages, all_new, frontier_reached, exhausted


def _search_forward_baseline(
    source: SearchSource,
    client: CachedHttpClient,
) -> list[dict[str, Any]]:
    """Capture one newest-first page as an explicit migration frontier.

    This is deliberately separate from discovery.  It is permitted only by
    ``harvest`` when the legacy catalog scan is known to cover the latest
    expected arXiv announcement date.  Treating an arbitrary mapped paper as a
    frontier can strand older, previously unseen search hits forever.
    """

    _require_newest_first(source.url)
    fetched = client.fetch(source.url)
    parsed = parse_search_page(fetched.text(), url=source.url)
    if parsed.total_results is None:
        raise HarvestError(
            f"search {source.name!r} has no stated result total while establishing "
            "its migration baseline"
        )
    if not parsed.ids:
        raise HarvestError(
            f"search {source.name!r} returned no IDs while establishing its "
            "forward-only migration baseline"
        )
    return [
        {
            "page": 1,
            "url": source.url,
            "contentSha256": fetched.content_sha256,
            "cacheStatus": fetched.cache_status,
            "ids": list(parsed.ids),
            "idCount": len(parsed.ids),
            "totalResults": parsed.total_results,
            "newIds": [],
        }
    ]


def _candidate_reason_add(
    reasons: dict[str, set[str]], identifier: str, reason: str
) -> None:
    reasons.setdefault(identifier, set()).add(reason)


def _listing_category_and_mode(url: str) -> tuple[str, str] | None:
    match = re.match(r"^/list/([^/]+)/(new|recent)/?$", urllib.parse.urlsplit(url).path)
    return None if match is None else (match.group(1), match.group(2))


def _latest_expected_weekday(raw: str) -> str:
    value = dt.date.fromisoformat(raw)
    while value.weekday() >= 5:
        value -= dt.timedelta(days=1)
    return value.isoformat()


def harvest(
    config: HarvestConfig,
    *,
    client: CachedHttpClient,
    ledger: Ledger | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Harvest configured sources and optionally record them in an active ledger run."""

    if (ledger is None) != (run_id is None):
        raise ValueError("ledger and run_id must be supplied together")
    known_versions = dict(config.known_versions)
    known_ids = set(known_versions)
    known_papers: dict[str, dict[str, Any]] = {}
    if ledger is not None:
        known_papers = ledger.known_papers()
        known_ids.update(known_papers)
        for identifier, paper in known_papers.items():
            observed_versions = [int(item["version"]) for item in paper.get("versions", [])]
            if observed_versions:
                known_versions[identifier] = max(
                    known_versions.get(identifier, 0), max(observed_versions)
                )
    ledger_plan = None
    if ledger is not None and run_id is not None:
        bound_coverage = ledger.planned_coverage(run_id)
        if (
            bound_coverage is not None
            and config.coverage_through is not None
            and config.coverage_through != bound_coverage["end"]
        ):
            raise HarvestError(
                "harvest coverageThrough conflicts with the interval bound to the active run"
            )
        ledger_plan = ledger.plan(
            through=(
                bound_coverage["end"]
                if bound_coverage is not None
                else config.coverage_through
            ),
            overlap_days=config.overlap_days,
            author_limit=config.author_limit,
            candidate_limit=config.review_limit,
        )
        if (
            bound_coverage is not None
            and bound_coverage != ledger_plan["coverage"]
        ):
            expected = ledger_plan["coverage"]
            raise HarvestError(
                "interval bound to the active run does not match the durable next "
                "coverage plan: "
                f"bound {bound_coverage['start']}..{bound_coverage['end']}, "
                f"expected {expected['start']}..{expected['end']}; "
                "abort the run and start a replacement from ledger plan output"
            )
    listing_output: list[dict[str, Any]] = []
    search_output: list[dict[str, Any]] = []
    reasons: dict[str, set[str]] = {}
    listing_evidence: dict[str, dict[str, Any]] = {}

    for source in config.listings:
        fetched = client.fetch(source.url)
        batches = parse_listing_page(fetched.text(), source=source.name)
        category_mode = _listing_category_and_mode(source.url)
        if category_mode:
            category, mode = category_mode
            evidence = listing_evidence.setdefault(
                category, {"dates": set(), "sources": set(), "modes": set()}
            )
            evidence["dates"].update(batch.announcement_date for batch in batches)
            evidence["sources"].add(source.name)
            evidence["modes"].add(mode)
        rendered_batches = []
        for batch in batches:
            batch_evidence = batch.as_json()
            rendered = dict(batch_evidence)
            rendered["idsSha256"] = sha256_bytes(
                canonical_json(list(batch.ids)).encode("utf-8")
            )
            rendered.pop("ids", None)
            if ledger is not None and run_id is not None:
                result = ledger.record_listing_batch(
                    run_id=run_id,
                    source=batch.source,
                    batch_key=batch.batch_key,
                    ids=batch.ids,
                    # Hash batch-local canonical evidence.  A /recent page
                    # changes whenever a new day is prepended; hashing the
                    # entire page would create duplicate snapshots of every
                    # unchanged historical date on every run.
                    payload=canonical_json(batch_evidence).encode("utf-8"),
                    # Broad category listings prove coverage; they are not a
                    # candidate queue.  Targeted searches below opt into
                    # discoveries only for IDs newer than their frontier.
                    discover=False,
                )
                rendered["replayed"] = result["replayed"]
            rendered_batches.append(rendered)
            for identifier in batch.ids:
                # Replacements are explicitly separated on /new, but /recent
                # folds them into ordinary dated groups.  Hydrate only the
                # bounded intersection with the known catalog so an
                # overlapping recovery run cannot miss yesterday's revision.
                known = known_papers.get(identifier, {})
                if known.get("inCatalog") or identifier in known_versions:
                    _candidate_reason_add(
                        reasons,
                        identifier,
                        f"known-listing:{source.name}:{batch.section}",
                    )
        listing_output.append(
            {
                "name": source.name,
                "url": source.url,
                "category": category_mode[0] if category_mode else None,
                "mode": category_mode[1] if category_mode else None,
                "contentSha256": fetched.content_sha256,
                "cacheStatus": fetched.cache_status,
                "batches": rendered_batches,
            }
        )

    coverage_evidence: dict[str, dict[str, Any]] = {}
    for category, evidence in sorted(listing_evidence.items()):
        dates = sorted(evidence["dates"])
        coverage_evidence[category] = {
            "earliest": dates[0] if dates else None,
            "latest": dates[-1] if dates else None,
            "sources": sorted(evidence["sources"]),
            "modes": sorted(evidence["modes"]),
        }
    if ledger_plan is not None:
        planned_start = ledger_plan["coverage"]["start"]
        expected_latest = config.expected_latest_date or _latest_expected_weekday(
            ledger_plan["coverage"]["end"]
        )
        for category, evidence in coverage_evidence.items():
            if evidence["earliest"] is None or evidence["earliest"] > planned_start:
                raise HarvestError(
                    f"listing evidence for {category} reaches only "
                    f"{evidence['earliest'] or 'no dated batch'}, not planned start {planned_start}; "
                    "run a manual backfill before advancing coverage"
                )
            if evidence["latest"] is None or evidence["latest"] < expected_latest:
                raise HarvestError(
                    f"listing evidence for {category} ends at "
                    f"{evidence['latest'] or 'no dated batch'}, before expected arXiv "
                    f"announcement date {expected_latest}; retry after the update or "
                    "use an explicit expectedLatestDate for a verified closure"
                )
    else:
        expected_latest = config.expected_latest_date

    # A one-time forward-only baseline is safe only when the imported legacy
    # catalog was scanned after the latest expected arXiv announcement.  It
    # captures the current top search page as the future frontier without
    # pretending that an arbitrary known/mapped paper proves complete search
    # coverage.  If the dates do not agree, migration requires explicit
    # frontiers or an exhaustive search and therefore fails closed.
    bootstrap_forward_allowed = False
    if ledger is not None:
        legacy_scan = ledger.get_metadata("catalog_last_successful_scan")
        completed_coverage = ledger.get_metadata("last_completed_coverage")
        if legacy_scan and not completed_coverage and expected_latest:
            bootstrap_forward_allowed = str(legacy_scan)[:10] == expected_latest

    effective_searches: list[tuple[SearchSource, str | None, bool]] = []
    skipped_author_cursors: list[tuple[str, dict[str, Any]]] = []
    for configured in config.searches:
        frontier = configured.frontier
        if not frontier and ledger is not None:
            frontier = _frontier_from_cursor(ledger.get_cursor("search", configured.name))
        bootstrap_forward = False
        if not frontier and not configured.exhaustive:
            if bootstrap_forward_allowed:
                bootstrap_forward = True
            else:
                raise HarvestError(
                    f"search {configured.name!r} needs a committed/configured frontier, "
                    "exhaustive=true, or a same-announcement-date legacy migration baseline"
                )
        effective_searches.append(
            (dataclasses.replace(configured, frontier=frontier), None, bootstrap_forward)
        )

    if config.include_due_authors:
        if ledger is None:
            raise HarvestError("includeDueAuthors requires a maintenance ledger")
        assert ledger_plan is not None
        for item in ledger_plan["authorsDue"]:
            author = str(item["displayName"])
            if re.search(r"\bcollaboration\b", author, flags=re.I):
                skipped_author_cursors.append(
                    (author, {"frontier": [], "skipped": "collaboration_name"})
                )
                continue
            frontier = _frontier_from_cursor(item.get("cursor"))
            bootstrap_forward = not frontier and bootstrap_forward_allowed
            if not frontier and not bootstrap_forward:
                raise HarvestError(
                    f"author search {author!r} has no committed frontier and the legacy "
                    "catalog is not current enough for a forward-only migration baseline"
                )
            effective_searches.append(
                (
                    SearchSource(
                        name=f"author:{author}",
                        url=_author_search_url(author),
                        frontier=frontier,
                        max_pages=2,
                        exhaustive=False,
                    ),
                    author,
                    bootstrap_forward,
                )
            )

    staged_search_cursors: list[tuple[str, dict[str, Any]]] = []
    staged_author_cursors: list[tuple[str, dict[str, Any]]] = list(skipped_author_cursors)
    for source, author_name, bootstrap_forward in effective_searches:
        if bootstrap_forward:
            pages = _search_forward_baseline(source, client)
            new_ids: list[str] = []
            frontier_reached = False
            exhausted = False
        else:
            pages, new_ids, frontier_reached, exhausted = _search_pages(source, client)
        for page in pages:
            if ledger is not None and run_id is not None:
                # Store a frontier-independent immutable snapshot of the page.
                # This remains idempotent when the committed frontier advances.
                result = ledger.record_listing_batch(
                    run_id=run_id,
                    source=(
                        f"author-page:{author_name}"
                        if author_name
                        else f"search-page:{source.name}"
                    ),
                    batch_key=f"page:{page['page']}:{_sha256_text(page['url'])[:16]}",
                    ids=page["ids"],
                    payload=client._memory[page["url"]].body,
                    discover=False,
                )
                page["replayed"] = result["replayed"]
                if page["newIds"]:
                    # Candidate discovery is a separate immutable delta whose
                    # identity includes both page evidence and the frontier.
                    frontier_digest = _sha256_text(canonical_json(list(source.frontier)))[:16]
                    delta_payload = canonical_json(
                        {
                            "pageContentSha256": page["contentSha256"],
                            "frontier": list(source.frontier),
                            "newIds": page["newIds"],
                        }
                    ).encode("utf-8")
                    delta = ledger.record_listing_batch(
                        run_id=run_id,
                        source=(
                            f"author:{author_name}"
                            if author_name
                            else f"search:{source.name}"
                        ),
                        batch_key=f"frontier:{frontier_digest}:page:{page['page']}",
                        ids=page["newIds"],
                        payload=delta_payload,
                        discover=True,
                    )
                    page["deltaReplayed"] = delta["replayed"]
        for identifier in new_ids:
            # A query-local frontier proves the result itself is new to this
            # search, not that its versionless ID is new to the catalog.  A
            # known paper may have acquired a revision outside the configured
            # listing categories, so every above-frontier hit is hydrated.
            _candidate_reason_add(reasons, identifier, f"search:{source.name}")
        next_frontier = list(dict.fromkeys(page_id for page in pages for page_id in page["ids"]))[:10]
        cursor_value = {"frontier": next_frontier}
        if author_name:
            staged_author_cursors.append((author_name, cursor_value))
        else:
            staged_search_cursors.append((source.name, cursor_value))
        search_output.append(
            {
                "name": source.name,
                "kind": "author" if author_name else "search",
                "pages": pages,
                "newIds": new_ids,
                "frontierReached": frontier_reached,
                "exhausted": exhausted,
                "nextFrontier": next_frontier,
                "bootstrapForward": bootstrap_forward,
            }
        )

    for identifier in config.explicit_ids:
        _candidate_reason_add(reasons, identifier, "explicit")

    pending: dict[str, Any] | None = None
    if ledger is not None:
        pending = ledger.review_bundle(limit=config.review_limit)
        if pending["truncated"]:
            raise HarvestError(
                "ledger review bundle exceeds reviewLimit; refusing partial candidate hydration"
            )
        for item in pending["metadataRequired"]:
            _candidate_reason_add(reasons, item["arxivId"], "ledger:metadata_required")

    pending_ids = (
        {
            item["arxivId"]
            for group in (pending["candidates"], pending["metadataRequired"])
            for item in group
        }
        if pending is not None
        else set()
    )
    prospective_review_count = (
        (pending["candidateCount"] if pending is not None else 0)
        + len(set(reasons) - pending_ids)
    )
    if prospective_review_count > config.review_limit:
        raise HarvestError(
            "candidate hydration would exceed reviewLimit "
            f"({prospective_review_count} > {config.review_limit}); "
            "narrow or split the discovery batch before fetching abstracts"
        )

    observed: list[dict[str, Any]] = []
    for identifier in sorted(reasons):
        abstract_url = f"https://arxiv.org/abs/{urllib.parse.quote(identifier, safe='/')}"
        fetched = client.fetch(abstract_url)
        metadata = parse_abstract_page(fetched.text(), expected_id=identifier)
        known_version = known_versions.get(identifier)
        is_candidate = known_version is None or metadata["version"] > known_version
        ledger_result: dict[str, Any] | None = None
        if ledger is not None and run_id is not None:
            ledger_result = ledger.observe_paper(
                run_id=run_id,
                arxiv_id=identifier,
                version=metadata["version"],
                metadata=metadata,
            )
            is_candidate = ledger_result["screeningStatus"] == "pending"
        if is_candidate:
            observed.append(
                {
                    "arxivId": identifier,
                    "version": metadata["version"],
                    "reasons": sorted(reasons[identifier]),
                    "metadata": metadata,
                    "metadataSha256": sha256_bytes(canonical_json(metadata).encode("utf-8")),
                    "contentSha256": fetched.content_sha256,
                }
            )

    if ledger is not None:
        # A failed/interrupted run may already have hydrated candidates in the
        # ledger.  Re-emit them without another network fetch so review work is
        # durable rather than tied to the run that first observed the paper.
        final_pending = ledger.review_bundle(limit=config.review_limit)
        if final_pending["truncated"] or final_pending["metadataRequired"]:
            raise HarvestError(
                "ledger still contains unhydrated or truncated review work after harvest"
            )
        fetched = {
            (item["arxivId"], item["version"]): item
            for item in observed
        }
        durable_candidates: list[dict[str, Any]] = []
        for item in final_pending["candidates"]:
            key = (item["arxivId"], item["version"])
            current = fetched.get(key, {})
            candidate = {
                "arxivId": item["arxivId"],
                "version": item["version"],
                "reasons": sorted(
                    set(current.get("reasons", [])) | {str(item["reason"])}
                ),
                "metadata": item["metadata"],
                "metadataSha256": item["metadataSha256"],
                "screeningStatus": item.get("screeningStatus", "pending"),
                "sources": item.get("sources", []),
            }
            if current.get("contentSha256"):
                candidate["contentSha256"] = current["contentSha256"]
            durable_candidates.append(candidate)
        observed = sorted(
            durable_candidates,
            key=lambda item: (item["arxivId"], item["version"]),
        )

    # Cursor promotion remains atomic in ledger.complete_run().  Stage it and
    # mark coverage lanes only after every requested page parsed and every
    # candidate hydrated successfully.
    if ledger is not None and run_id is not None:
        for name, value in staged_search_cursors:
            ledger.stage_cursor(run_id=run_id, lane="search", key=name, value=value)
        for author, value in staged_author_cursors:
            ledger.stage_author_cursor(run_id=run_id, author=author, value=value)
        listing_changes = sum(
            1
            for source in listing_output
            for batch in source["batches"]
            if not batch.get("replayed", False)
        )
        ordinary_searches = [item for item in search_output if item["kind"] == "search"]
        author_searches = [item for item in search_output if item["kind"] == "author"]
        ledger.set_lane(
            run_id,
            "listings",
            "completed" if listing_changes else "no_change",
            {
                "sources": len(listing_output),
                "immutableBatchesAdded": listing_changes,
            },
        )
        ledger.set_lane(
            run_id,
            "searches",
            "completed" if any(item["newIds"] for item in ordinary_searches) else "no_change",
            {
                "searches": len(ordinary_searches),
                "newIds": sum(len(item["newIds"]) for item in ordinary_searches),
            },
        )
        if config.include_due_authors:
            ledger.set_lane(
                run_id,
                "authors",
                "completed" if any(item["newIds"] for item in author_searches) else "no_change",
                {
                    "authorsSearched": len(author_searches),
                    "authorsSkipped": len(skipped_author_cursors),
                    "newIds": sum(len(item["newIds"]) for item in author_searches),
                },
            )

    # Keep the model-facing bundle compact.  Full listing/search ID sets live
    # in the immutable ledger rows and URL-addressed HTTP cache; the bundle
    # needs only counts, digests, frontier deltas, and actual candidates.
    for search in search_output:
        for page in search["pages"]:
            page["idsSha256"] = sha256_bytes(
                canonical_json(page["ids"]).encode("utf-8")
            )
            page["newIdCount"] = len(page["newIds"])
            page.pop("ids", None)
            page.pop("newIds", None)

    stable_payload = {
        "schemaVersion": BUNDLE_SCHEMA_VERSION,
        "coverage": {
            "planned": (
                {
                    **ledger_plan["coverage"],
                    "expectedLatest": expected_latest,
                }
                if ledger_plan is not None
                else None
            ),
            "evidence": coverage_evidence,
        },
        "listings": listing_output,
        "searches": search_output,
        "candidates": observed,
    }
    # cacheStatus/replayed are useful operational metrics but do not participate
    # in the semantic digest.
    semantic = json.loads(canonical_json(stable_payload))
    for listing in semantic["listings"]:
        listing.pop("cacheStatus", None)
        for batch in listing["batches"]:
            batch.pop("replayed", None)
    for search in semantic["searches"]:
        for page in search["pages"]:
            page.pop("cacheStatus", None)
            page.pop("replayed", None)
            page.pop("deltaReplayed", None)
    return {
        **stable_payload,
        "candidateCount": len(observed),
        "semanticSha256": sha256_bytes(canonical_json(semantic).encode("utf-8")),
        "fetchMetrics": client.metrics.as_json(),
    }


def _write_json(path: str | None, value: Any, *, pretty: bool) -> None:
    output = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    ) + "\n"
    if path:
        _atomic_write(Path(path).expanduser().resolve(), output.encode("utf-8"))
    else:
        print(output, end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="harvest configuration JSON")
    parser.add_argument("--cache-dir", required=True, help="persistent HTTP cache directory")
    parser.add_argument("--output", help="candidate bundle path (stdout by default)")
    parser.add_argument("--state", help="optional maintenance-ledger SQLite path")
    parser.add_argument("--run-id", help="active ledger run ID (required with --state)")
    parser.add_argument("--delay", type=float, default=3.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--cache-max-age", type=float, default=0.0)
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if bool(arguments.state) != bool(arguments.run_id):
        print(json.dumps({"error": "--state and --run-id must be used together"}), file=sys.stderr)
        return 2
    try:
        config_value = json.loads(Path(arguments.config).read_text(encoding="utf-8"))
        if not isinstance(config_value, dict):
            raise ValueError("harvest configuration must be a JSON object")
        config = HarvestConfig.from_json(config_value)
        client = CachedHttpClient(
            arguments.cache_dir,
            delay_seconds=arguments.delay,
            retries=arguments.retries,
            timeout_seconds=arguments.timeout,
            cache_max_age_seconds=arguments.cache_max_age,
            user_agent=arguments.user_agent,
        )
        if arguments.state:
            with Ledger(arguments.state) as ledger:
                ledger._ensure_initialized()
                result = harvest(config, client=client, ledger=ledger, run_id=arguments.run_id)
        else:
            result = harvest(config, client=client)
        _write_json(arguments.output, result, pretty=arguments.pretty)
        return 0
    except (HarvestError, ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
