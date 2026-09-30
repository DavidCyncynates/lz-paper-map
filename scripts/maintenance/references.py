"""Fetch complete arXiv HTML bibliographies and record immutable snapshots.

Automatic extraction uses only the public ``/html/`` representation.  It is
deliberately fail-closed: a document must identify its exact arXiv version and
contain a recognizable bibliography container before any snapshot is written.
For papers without an HTML conversion, a strict, exact-version manual snapshot
can attest a complete bibliography read from the official PDF.  No heuristic
PDF parser is used.

Typical daily use against an active ledger run is::

    python3 -m scripts.maintenance.references \
        --state /path/to/maintenance.sqlite3 --run-id RUN_ID \
        --landscape data/landscape.json --cache-dir /path/to/http-cache

That mode resolves only missing or stale mapped-paper snapshots.  Standalone
use accepts a bounded set of ``--id`` values and emits deterministic JSON.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import html.parser
import json
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .harvest import (
    CachedHttpClient,
    HarvestError,
    ParseError,
    _atomic_write,
    html_parser_errors,
)
from .ledger import Ledger, LedgerError, canonical_arxiv_ids, canonical_json, normalize_arxiv_id


REFERENCE_BUNDLE_SCHEMA_VERSION = 1
_SPACE = re.compile(r"\s+")
_ID_BODY = r"(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.\-]+/\d{7})(?:v\d+)?"
_BARE_ARXIV_ID = re.compile(
    rf"(?i)(?<![a-z0-9.])(?P<id>{_ID_BODY})(?![a-z0-9/])"
)
_LABELED_ARXIV_ID = re.compile(
    rf"(?i)\barxiv\s*(?::|\.)\s*(?P<id>{_ID_BODY})(?![a-z0-9/])"
)
_ARXIV_PATH_ID = re.compile(
    rf"(?i)/(?:abs|pdf|html)/(?P<id>{_ID_BODY})(?:\.pdf)?(?:/)?$"
)
_DOI_ARXIV_ID = re.compile(rf"(?i)/arxiv\.(?P<id>{_ID_BODY})(?:[/?#]|$)")
_VERSIONED_ID = re.compile(
    r"(?i)(?:^|/)(?:abs|pdf|html)/(?P<id>"
    + _ID_BODY
    + r")(?:\.pdf)?(?:/)?$"
)
_BIBLIOGRAPHY_IDS = frozenset(("bib", "bibliography", "references", "reference-list"))
_BIBLIOGRAPHY_CLASSES = frozenset(
    ("ltx_bibliography", "bibliography", "reference-list", "references")
)
_IDENTITY_CONTAINER_IDS = frozenset(
    ("arxiv-id", "arxiv_id", "watermark", "watermark-tl", "watermark-tr")
)
_IDENTITY_CONTAINER_CLASSES = frozenset(
    ("arxiv-id", "arxiv_id", "arxiv-watermark", "ltx_page_logo", "watermark")
)
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


class BibliographyParseError(ParseError):
    """Raised when complete bibliography extraction cannot be proved."""


def _clean_text(value: str) -> str:
    return _SPACE.sub(" ", value).strip()


def _ids_from_href(href: str) -> list[str]:
    """Extract explicit arXiv identifiers from one reference link."""

    decoded = urllib.parse.unquote(href.strip())
    parsed = urllib.parse.urlsplit(decoded)
    values: list[str] = []
    host = (parsed.hostname or "").lower()
    if not host or host in ("arxiv.org", "www.arxiv.org", "export.arxiv.org"):
        match = _ARXIV_PATH_ID.search(parsed.path.rstrip("/"))
        if match:
            values.append(match.group("id"))
    doi_match = _DOI_ARXIV_ID.search(parsed.path)
    if doi_match:
        values.append(doi_match.group("id"))
    values.extend(match.group("id") for match in _LABELED_ARXIV_ID.finditer(decoded))
    return values


def _identity_from_url(value: str) -> tuple[str, int | None] | None:
    decoded = urllib.parse.unquote(value.strip())
    parsed = urllib.parse.urlsplit(decoded)
    match = _VERSIONED_ID.search(parsed.path.rstrip("/"))
    if match is None:
        return None
    try:
        return normalize_arxiv_id(match.group("id"))
    except ValueError:
        return None


def _recognized_bibliography(attributes: Mapping[str, str]) -> bool:
    classes = frozenset(attributes.get("class", "").casefold().split())
    element_id = attributes.get("id", "").casefold().strip()
    role = attributes.get("role", "").casefold().strip()
    return bool(
        classes.intersection(_BIBLIOGRAPHY_CLASSES)
        or element_id in _BIBLIOGRAPHY_IDS
        or role == "doc-bibliography"
    )


class _BibliographyParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []
        self.container_count = 0
        self.bibliography_text: list[str] = []
        self.bibliography_hrefs: list[str] = []
        self.identity_candidates: list[tuple[str, int | None, str]] = []
        self.identity_text: list[str] = []

    @property
    def inside_bibliography(self) -> bool:
        return bool(self.stack and self.stack[-1][1])

    @property
    def inside_identity_container(self) -> bool:
        return bool(self.stack and self.stack[-1][2])

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        attributes = {key.casefold(): value or "" for key, value in attrs}
        self._consume_identity(tag, attributes)
        recognized = _recognized_bibliography(attributes)
        inside = self.inside_bibliography or recognized
        identity_container = self.inside_identity_container or self._is_identity_container(
            attributes
        )
        if recognized:
            self.container_count += 1
        if inside and tag == "a" and attributes.get("href"):
            self.bibliography_hrefs.append(attributes["href"])
        if tag not in _VOID_ELEMENTS:
            self.stack.append((tag, inside, identity_container))

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        tag = tag.casefold()
        attributes = {key.casefold(): value or "" for key, value in attrs}
        self._consume_identity(tag, attributes)
        recognized = _recognized_bibliography(attributes)
        if recognized:
            self.container_count += 1
        if (self.inside_bibliography or recognized) and tag == "a" and attributes.get(
            "href"
        ):
            self.bibliography_hrefs.append(attributes["href"])

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self.inside_bibliography:
            self.bibliography_text.append(data)
        if self.inside_identity_container:
            self.identity_text.append(data)

    @staticmethod
    def _is_identity_container(attributes: Mapping[str, str]) -> bool:
        element_id = attributes.get("id", "").casefold().strip()
        classes = frozenset(attributes.get("class", "").casefold().split())
        return bool(
            element_id in _IDENTITY_CONTAINER_IDS
            or classes.intersection(_IDENTITY_CONTAINER_CLASSES)
        )

    def _consume_identity(self, tag: str, attributes: Mapping[str, str]) -> None:
        if tag == "link" and "canonical" in attributes.get("rel", "").casefold().split():
            self._append_identity(attributes.get("href", ""), "canonical")
        elif tag == "base":
            self._append_identity(attributes.get("href", ""), "base")
        elif tag == "meta":
            name = (
                attributes.get("name")
                or attributes.get("property")
                or attributes.get("http-equiv")
                or ""
            ).casefold()
            if name in (
                "citation_arxiv_id",
                "citation_pdf_url",
                "dc.identifier",
                "dc.identifier.uri",
            ):
                value = attributes.get("content", "")
                identity = _identity_from_url(value)
                if identity is None:
                    try:
                        identity = normalize_arxiv_id(value)
                    except ValueError:
                        identity = None
                if identity is not None:
                    self.identity_candidates.append((*identity, f"meta:{name}"))

    def _append_identity(self, value: str, source: str) -> None:
        identity = _identity_from_url(value)
        if identity is not None:
            self.identity_candidates.append((*identity, source))


@dataclasses.dataclass(frozen=True)
class BibliographySnapshot:
    arxiv_id: str
    version: int
    references: tuple[str, ...]
    identity_sources: tuple[str, ...]
    bibliography_containers: int

    def as_json(self) -> dict[str, Any]:
        return {
            "arxivId": self.arxiv_id,
            "version": self.version,
            "referenceCount": len(self.references),
            "references": list(self.references),
            "bibliographyContainers": self.bibliography_containers,
            "identitySources": list(self.identity_sources),
        }


@dataclasses.dataclass(frozen=True)
class ManualBibliographySnapshot:
    arxiv_id: str
    version: int
    references: tuple[str, ...]
    source_url: str

    def as_document_json(self) -> dict[str, Any]:
        evidence = {
            "arxivId": self.arxiv_id,
            "version": self.version,
            "references": list(self.references),
            "sourceUrl": self.source_url,
            "complete": True,
        }
        return {
            "arxivId": self.arxiv_id,
            "version": self.version,
            "referenceCount": len(self.references),
            "references": list(self.references),
            "bibliographyContainers": None,
            "identitySources": ["manual:complete-attestation"],
            "sourceUrl": self.source_url,
            "requestedUrl": self.source_url,
            "contentSha256": hashlib.sha256(
                canonical_json(evidence).encode("utf-8")
            ).hexdigest(),
            "cacheStatus": "manual",
        }


def parse_manual_snapshots(value: Any) -> list[ManualBibliographySnapshot]:
    """Validate exact-version, complete manual/PDF bibliography evidence."""

    if isinstance(value, dict):
        value = value.get("snapshots")
    if not isinstance(value, list):
        raise ValueError("manual snapshots file must be an array or {\"snapshots\": [...]}")
    snapshots: list[ManualBibliographySnapshot] = []
    seen: set[tuple[str, int]] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"manual snapshot {index} must be an object")
        if item.get("complete") is not True:
            raise ValueError(f"manual snapshot {index} must explicitly set complete: true")
        raw_id = item.get("arxivId")
        raw_version = item.get("version")
        references = item.get("references")
        source_url = item.get("sourceUrl")
        if (
            not isinstance(raw_id, str)
            or isinstance(raw_version, bool)
            or not isinstance(raw_version, int)
        ):
            raise ValueError(f"manual snapshot {index} needs an exact arxivId and version")
        identifier, embedded_version = normalize_arxiv_id(raw_id)
        if raw_version <= 0 or (
            embedded_version is not None and embedded_version != raw_version
        ):
            raise ValueError(f"manual snapshot {index} has a conflicting/invalid version")
        if not isinstance(references, list) or not all(
            isinstance(reference, str) for reference in references
        ):
            raise ValueError(f"manual snapshot {index} references must be an array of IDs")
        if not isinstance(source_url, str):
            raise ValueError(f"manual snapshot {index} needs an official sourceUrl")
        parsed_source = urllib.parse.urlsplit(source_url)
        source_identity = _identity_from_url(source_url)
        if (
            parsed_source.scheme != "https"
            or (parsed_source.hostname or "").casefold()
            not in ("arxiv.org", "www.arxiv.org", "export.arxiv.org")
            or source_identity != (identifier, raw_version)
        ):
            raise ValueError(
                f"manual snapshot {index} sourceUrl must be an exact-version official "
                "arXiv abs, html, or PDF URL"
            )
        key = (identifier, raw_version)
        if key in seen:
            raise ValueError(f"duplicate manual snapshot: {identifier}v{raw_version}")
        seen.add(key)
        snapshots.append(
            ManualBibliographySnapshot(
                arxiv_id=identifier,
                version=raw_version,
                references=tuple(canonical_arxiv_ids(references)),
                source_url=source_url,
            )
        )
    return sorted(snapshots, key=lambda item: (item.arxiv_id, item.version))


def parse_bibliography_html(
    document: str,
    *,
    expected_id: str | None = None,
    expected_version: int | None = None,
) -> BibliographySnapshot:
    """Parse one complete arXiv HTML bibliography.

    Bare identifiers are considered only inside a recognized bibliography.
    Document identity is independently established from canonical metadata,
    not from links in the bibliography itself.
    """

    parser = _BibliographyParser()
    try:
        parser.feed(document)
        parser.close()
    except html_parser_errors() as error:
        raise BibliographyParseError(f"malformed arXiv HTML: {error}") from error
    if parser.container_count == 0:
        raise BibliographyParseError("no recognizable bibliography container")

    normalized_expected: str | None = None
    embedded_version: int | None = None
    if expected_id is not None:
        normalized_expected, embedded_version = normalize_arxiv_id(expected_id)
        if expected_version is None:
            expected_version = embedded_version
        elif embedded_version is not None and embedded_version != expected_version:
            raise ValueError("expected version conflicts with version in expected arXiv ID")

    watermark = _clean_text(" ".join(parser.identity_text))
    for match in _LABELED_ARXIV_ID.finditer(watermark):
        identifier, version = normalize_arxiv_id(match.group("id"))
        parser.identity_candidates.append((identifier, version, "watermark"))

    identities = {
        (identifier, version) for identifier, version, _ in parser.identity_candidates
    }
    identifiers = {identifier for identifier, _version in identities}
    if not identifiers:
        raise BibliographyParseError("document has no recognizable canonical arXiv identity")
    if len(identifiers) != 1:
        raise BibliographyParseError(
            "document canonical metadata has conflicting arXiv identities"
        )
    identifier = next(iter(identifiers))
    if normalized_expected is not None and identifier != normalized_expected:
        raise BibliographyParseError(
            f"document identity mismatch: expected {normalized_expected}, received {identifier}"
        )

    versions = {version for _identifier, version in identities if version is not None}
    if not versions:
        raise BibliographyParseError("document has missing canonical version metadata")
    if expected_version is not None:
        if versions != {expected_version}:
            raise BibliographyParseError(
                f"document version mismatch: expected v{expected_version}, "
                f"received {', '.join(f'v{value}' for value in sorted(versions))}"
            )
        version = expected_version
    else:
        if len(versions) != 1:
            raise BibliographyParseError(
                "document has conflicting canonical version metadata"
            )
        version = next(iter(versions))

    raw_ids: list[str] = []
    for href in parser.bibliography_hrefs:
        raw_ids.extend(_ids_from_href(href))
    bibliography_text = _clean_text(" ".join(parser.bibliography_text))
    raw_ids.extend(
        match.group("id") for match in _LABELED_ARXIV_ID.finditer(bibliography_text)
    )
    raw_ids.extend(
        match.group("id") for match in _BARE_ARXIV_ID.finditer(bibliography_text)
    )
    references = tuple(canonical_arxiv_ids(raw_ids))
    identity_sources = tuple(
        sorted({source for _id, _version, source in parser.identity_candidates})
    )
    return BibliographySnapshot(
        arxiv_id=identifier,
        version=version,
        references=references,
        identity_sources=identity_sources,
        bibliography_containers=parser.container_count,
    )


def _read_landscape_ids(path: str | Path) -> list[str]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    papers = value.get("papers") if isinstance(value, dict) else None
    if not isinstance(papers, list):
        raise ValueError("landscape JSON does not contain a papers array")
    values: list[str] = []
    for paper in papers:
        if not isinstance(paper, dict):
            raise ValueError("every landscape paper must be an object")
        raw = paper.get("arxivId") or paper.get("id")
        if not isinstance(raw, str):
            raise ValueError("every landscape paper needs an arxivId or id")
        values.append(raw)
    return canonical_arxiv_ids(values)


def _read_ids_file(path: str | Path) -> list[str]:
    text = Path(path).read_text(encoding="utf-8")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = [line.strip() for line in text.splitlines() if line.strip()]
    if isinstance(parsed, dict):
        parsed = parsed.get("ids")
    if not isinstance(parsed, list):
        raise ValueError("IDs file must be an array, {\"ids\": [...]}, or one ID per line")
    return [str(value) for value in parsed]


def resolve_targets(
    *,
    explicit_ids: Iterable[str],
    ledger: Ledger | None = None,
    landscape_path: str | Path | None = None,
) -> tuple[list[tuple[str, int | None]], dict[str, Any] | None]:
    """Resolve a deterministic, deduplicated bibliography work list."""

    explicit: set[tuple[str, int | None]] = set()
    for raw in explicit_ids:
        identifier, version = normalize_arxiv_id(raw)
        if version is None and any(item[0] == identifier for item in explicit):
            raise ValueError(
                f"versionless and exact explicit targets conflict for {identifier}"
            )
        if version is not None and (identifier, None) in explicit:
            raise ValueError(
                f"versionless and exact explicit targets conflict for {identifier}"
            )
        explicit.add((identifier, version))

    coverage: dict[str, Any] | None = None
    selected = set(explicit)
    if ledger is not None:
        if landscape_path is None:
            raise ValueError("--landscape is required with ledger-backed target resolution")
        mapped_ids = _read_landscape_ids(landscape_path)
        coverage = ledger.mapped_citations(mapped_ids)
        known = ledger.known_papers()
        for identifier in (
            coverage["missingSnapshotIds"] + coverage["staleSnapshotIds"]
        ):
            known_paper = known.get(identifier, {})
            versions = known_paper.get("versions", [])
            expected_versions = [int(item["version"]) for item in versions]
            catalog_version = known_paper.get("catalogVersion")
            if catalog_version is not None:
                expected_versions.append(int(catalog_version))
            latest = max(expected_versions, default=None)
            # Preserve deliberately requested older exact versions while also
            # adding the exact version required by mapped coverage.  A
            # versionless request becomes the ledger-known exact version so it
            # cannot fetch a moving latest document by accident.
            if latest is not None:
                selected.discard((identifier, None))
                selected.add((identifier, latest))
            elif not any(
                paper_id == identifier and version is not None
                for paper_id, version in selected
            ):
                selected.add((identifier, None))

        # A clearly relevant paper/version does not enter landscape.json until
        # the public change is written.  Include those accepted-unpublished
        # exact versions automatically so the references lane cannot pass only
        # because an operator remembered to repeat --id by hand.
        for item in ledger.missing_relevant_reference_targets():
            selected.add((item["arxivId"], int(item["version"])))
    if not selected:
        return [], coverage
    return sorted(
        selected,
        key=lambda item: (item[0], -1 if item[1] is None else item[1]),
    ), coverage


def harvest_references(
    targets: Iterable[tuple[str, int | None]],
    *,
    client: CachedHttpClient,
    manual_snapshots: Iterable[ManualBibliographySnapshot] = (),
    ledger: Ledger | None = None,
    run_id: str | None = None,
    supersede: bool = False,
    mark_lane: bool = True,
) -> dict[str, Any]:
    """Fetch and parse all targets before recording or completing the lane."""

    if (ledger is None) != (run_id is None):
        raise ValueError("ledger and run_id must be provided together")
    planned = list(targets)
    normalized_planned = [
        (normalize_arxiv_id(identifier)[0], version)
        for identifier, version in planned
    ]
    if len(set(normalized_planned)) != len(planned):
        raise ValueError("targets must contain each exact arXiv version at most once")
    manual_list = list(manual_snapshots)
    manual_by_key = {
        (item.arxiv_id, item.version): item for item in manual_list
    }
    if len(manual_by_key) != len(manual_list):
        raise ValueError("manual snapshots must contain each exact version at most once")
    unknown_manual = sorted(set(manual_by_key).difference(normalized_planned))
    if unknown_manual:
        raise ValueError(
            "manual snapshots are not present in the resolved target set: "
            + ", ".join(f"{identifier}v{version}" for identifier, version in unknown_manual)
        )

    extracted: list[dict[str, Any]] = []
    # First prove every requested document complete.  No ledger state changes
    # occur during this phase, so one bad page cannot create a partial batch.
    for identifier, expected_version in planned:
        normalized, embedded = normalize_arxiv_id(identifier)
        if embedded is not None:
            if expected_version is not None and embedded != expected_version:
                raise ValueError(f"conflicting target version for {normalized}")
            expected_version = embedded
        manual = (
            manual_by_key.get((normalized, expected_version))
            if expected_version is not None
            else None
        )
        if manual is not None:
            if expected_version is not None and manual.version != expected_version:
                raise ValueError(
                    f"manual snapshot version for {normalized} conflicts with target "
                    f"v{expected_version}"
                )
            extracted.append(manual.as_document_json())
            continue
        suffix = f"v{expected_version}" if expected_version is not None else ""
        request_url = f"https://arxiv.org/html/{normalized}{suffix}"
        fetched = client.fetch(request_url)
        snapshot = parse_bibliography_html(
            fetched.text(),
            expected_id=normalized,
            expected_version=expected_version,
        )
        source_url = f"https://arxiv.org/html/{snapshot.arxiv_id}v{snapshot.version}"
        extracted.append(
            {
                **snapshot.as_json(),
                "sourceUrl": source_url,
                "requestedUrl": request_url,
                "contentSha256": fetched.content_sha256,
                "cacheStatus": fetched.cache_status,
            }
        )

    recorded: list[dict[str, Any]] = []
    if ledger is not None and run_id is not None:
        recorded = ledger.record_reference_snapshots_batch(
            run_id=run_id,
            snapshots=(
                {
                    "arxiv_id": item["arxivId"],
                    "version": item["version"],
                    "references": item["references"],
                    "source_url": item["sourceUrl"],
                }
                for item in extracted
            ),
            supersede=supersede,
        )
        if mark_lane:
            changed = sum(not item["replayed"] for item in recorded)
            ledger.set_lane(
                run_id,
                "references",
                "completed" if changed else "no_change",
                {
                    "targetCount": len(planned),
                    "snapshotCount": len(recorded),
                    "snapshotsAdded": changed,
                },
            )

    semantic_documents = [
        {
            key: value
            for key, value in item.items()
            if key not in ("cacheStatus", "requestedUrl")
        }
        for item in extracted
    ]
    semantic_sha256 = hashlib.sha256(
        canonical_json(semantic_documents).encode("utf-8")
    ).hexdigest()
    return {
        "schemaVersion": REFERENCE_BUNDLE_SCHEMA_VERSION,
        "targetCount": len(planned),
        "documents": extracted,
        "recordedSnapshots": recorded,
        "semanticSha256": semantic_sha256,
        "fetchMetrics": client.metrics.as_json(),
    }


def _write_json(path: str | None, value: Any, *, pretty: bool) -> None:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    ) + "\n"
    if path:
        _atomic_write(Path(path).expanduser().resolve(), serialized.encode("utf-8"))
    else:
        print(serialized, end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, help="persistent HTTP cache directory")
    parser.add_argument("--id", action="append", help="bounded arXiv ID or IDvN; repeat as needed")
    parser.add_argument("--ids-file", help="JSON or newline-delimited arXiv IDs")
    parser.add_argument(
        "--manual-snapshots-file",
        help="strict exact-version complete snapshots for papers without arXiv HTML",
    )
    parser.add_argument(
        "--landscape",
        default="data/landscape.json",
        help="mapped catalog used to resolve missing/stale snapshots in ledger mode",
    )
    parser.add_argument("--state", help="maintenance-ledger SQLite path")
    parser.add_argument("--run-id", help="active run ID (required with --state)")
    parser.add_argument("--limit", type=int, default=200, help="maximum documents per invocation")
    parser.add_argument("--supersede", action="store_true")
    parser.add_argument("--no-mark-lane", action="store_true")
    parser.add_argument("--output")
    parser.add_argument("--delay", type=float, default=3.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--cache-max-age", type=float, default=0.0)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if bool(arguments.state) != bool(arguments.run_id):
        print(json.dumps({"error": "--state and --run-id must be used together"}), file=sys.stderr)
        return 2
    try:
        explicit = list(arguments.id or [])
        if arguments.ids_file:
            explicit.extend(_read_ids_file(arguments.ids_file))
        manual: list[ManualBibliographySnapshot] = []
        if arguments.manual_snapshots_file:
            manual = parse_manual_snapshots(
                json.loads(
                    Path(arguments.manual_snapshots_file).read_text(encoding="utf-8")
                )
            )
            explicit.extend(f"{item.arxiv_id}v{item.version}" for item in manual)
        if arguments.limit <= 0:
            raise ValueError("--limit must be positive")
        client = CachedHttpClient(
            arguments.cache_dir,
            delay_seconds=arguments.delay,
            retries=arguments.retries,
            timeout_seconds=arguments.timeout,
            cache_max_age_seconds=arguments.cache_max_age,
        )
        if arguments.state:
            with Ledger(arguments.state) as ledger:
                ledger._ensure_initialized()
                targets, prior_coverage = resolve_targets(
                    explicit_ids=explicit,
                    ledger=ledger,
                    landscape_path=arguments.landscape,
                )
                if len(targets) > arguments.limit:
                    raise ValueError(
                        f"resolved {len(targets)} bibliography targets, exceeding --limit "
                        f"{arguments.limit}"
                    )
                result = harvest_references(
                    targets,
                    client=client,
                    manual_snapshots=manual,
                    ledger=ledger,
                    run_id=arguments.run_id,
                    supersede=arguments.supersede,
                    mark_lane=False,
                )
                mapped = _read_landscape_ids(arguments.landscape)
                result["coverageBefore"] = prior_coverage
                coverage_after = ledger.mapped_citations(mapped)
                result["coverageAfter"] = coverage_after
                if not coverage_after["coverageComplete"]:
                    raise HarvestError(
                        "reference snapshot batch did not complete mapped coverage; "
                        "references lane was not marked"
                    )
                if not arguments.no_mark_lane:
                    changed = sum(
                        not item["replayed"] for item in result["recordedSnapshots"]
                    )
                    ledger.set_lane(
                        arguments.run_id,
                        "references",
                        "completed" if changed else "no_change",
                        {
                            "targetCount": len(targets),
                            "snapshotCount": len(result["recordedSnapshots"]),
                            "snapshotsAdded": changed,
                            "coverageComplete": True,
                        },
                    )
        else:
            targets, _coverage = resolve_targets(explicit_ids=explicit)
            if not targets:
                raise ValueError("standalone mode requires at least one --id or --ids-file value")
            if len(targets) > arguments.limit:
                raise ValueError(
                    f"resolved {len(targets)} bibliography targets, exceeding --limit "
                    f"{arguments.limit}"
                )
            result = harvest_references(
                targets, client=client, manual_snapshots=manual
            )
        _write_json(arguments.output, result, pretty=arguments.pretty)
        return 0
    except (HarvestError, LedgerError, ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
