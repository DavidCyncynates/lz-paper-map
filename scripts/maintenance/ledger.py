"""Durable, transactional state for incremental LZ-map maintenance.

The public ``data/landscape.json`` file remains the source of truth for the
website.  This database is a rebuildable maintenance ledger: it remembers
which source material has already been seen, stages source cursors until a
coverage run succeeds, and packages only new or changed candidates for human
or model review.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence
from zoneinfo import ZoneInfo


SCHEMA_VERSION = 2
DEFAULT_REQUIRED_LANES = (
    "listings",
    "searches",
    "citation_discovery",
    "authors",
    "references",
)
SUCCESSFUL_LANE_STATES = frozenset(("completed", "no_change"))
LANE_STATES = frozenset((*SUCCESSFUL_LANE_STATES, "deferred", "failed"))
SCREENING_STATES = frozenset(("pending", "relevant", "excluded", "ambiguous"))
FINAL_SCREENING_STATES = frozenset(("relevant", "excluded", "ambiguous"))

_MODERN_ARXIV_ID = re.compile(r"(?i)^(\d{4}\.\d{4,5})(?:v(\d+))?$")
_LEGACY_ARXIV_ID = re.compile(r"(?i)^([a-z][a-z0-9.\-]+/\d{7})(?:v(\d+))?$")


class LedgerError(RuntimeError):
    """Base error for maintenance-ledger operations."""


class ConflictError(LedgerError):
    """Raised when immutable evidence conflicts with an existing record."""


class IncompleteRunError(LedgerError):
    """Raised when a coverage run is completed without all required lanes."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def default_state_path() -> Path:
    """Return a stable state location that is not tied to a Git worktree."""

    override = os.environ.get("LZ_MAINTENANCE_STATE")
    if override:
        return Path(override).expanduser().resolve()
    return (
        Path.home()
        / ".codex"
        / "automations"
        / "refresh-lz-paper-map"
        / "state"
        / "maintenance.sqlite3"
    )


def normalize_arxiv_id(raw: str) -> tuple[str, int | None]:
    """Normalize a modern or legacy arXiv identifier and extract its version."""

    value = raw.strip()
    value = re.sub(r"(?i)^https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/", "", value)
    value = re.sub(r"(?i)^arxiv:\s*", "", value)
    value = value.split("?", 1)[0].split("#", 1)[0]
    value = re.sub(r"(?i)\.pdf$", "", value).strip().strip("/")
    match = _MODERN_ARXIV_ID.fullmatch(value) or _LEGACY_ARXIV_ID.fullmatch(value)
    if not match:
        raise ValueError(f"not a supported arXiv identifier: {raw!r}")
    identifier = match.group(1).lower()
    version = int(match.group(2)) if match.group(2) else None
    return identifier, version


def canonical_arxiv_ids(values: Iterable[str]) -> list[str]:
    """Return sorted, unique, versionless arXiv identifiers."""

    return sorted({normalize_arxiv_id(value)[0] for value in values})


def normalize_author(author: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", author).casefold().split())


def catalog_arxiv_version(paper: Mapping[str, Any]) -> int | None:
    """Read an exact published arXiv version; never infer it from a date."""

    raw_identifier = str(paper.get("arxivId") or paper.get("id") or "")
    _identifier, embedded = normalize_arxiv_id(raw_identifier)
    raw = paper.get("arxivVersion", paper.get("version"))
    if raw is None:
        return embedded
    if isinstance(raw, bool):
        raise ValueError("catalog arxivVersion must be a positive integer")
    if isinstance(raw, str):
        raw = raw.strip().lower()
        if raw.startswith("v"):
            raw = raw[1:]
    try:
        version = int(raw)
    except (TypeError, ValueError) as error:
        raise ValueError("catalog arxivVersion must be a positive integer") from error
    if version <= 0:
        raise ValueError("catalog arxivVersion must be a positive integer")
    if embedded is not None and embedded != version:
        raise ValueError("catalog arxivVersion conflicts with the versioned arXiv ID")
    return version


def _metadata_for_hash(metadata: Mapping[str, Any]) -> dict[str, Any]:
    ignored = {"retrievedAt", "retrieved_at", "sourceUrl", "source_url"}
    return {key: metadata[key] for key in sorted(metadata) if key not in ignored}


def _date_part(timestamp: str | None) -> str | None:
    if not timestamp:
        return None
    return timestamp[:10]


def _iso_date(value: str, field: str) -> str:
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO date (YYYY-MM-DD)") from error


def latest_expected_announcement_date(today: dt.date | None = None) -> dt.date:
    """Return the newest arXiv announcement date expected by 11:00 in Rome."""

    local_date = today or dt.datetime.now(ZoneInfo("Europe/Rome")).date()
    if local_date.weekday() == 5:  # Saturday
        return local_date - dt.timedelta(days=1)
    if local_date.weekday() == 6:  # Sunday
        return local_date - dt.timedelta(days=2)
    return local_date


class Ledger:
    """SQLite-backed maintenance ledger.

    Every public method that mutates state uses ``BEGIN IMMEDIATE`` and either
    commits the complete operation or rolls it back.  Source cursors are first
    staged against a run and promoted only by :meth:`complete_run`.
    """

    def __init__(self, state_path: str | os.PathLike[str] | None = None):
        self.path = Path(state_path) if state_path is not None else default_state_path()
        self.path = self.path.expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, timeout=30.0)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = FULL")
        self.connection.execute("PRAGMA busy_timeout = 30000")

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "Ledger":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @contextlib.contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
        except Exception:
            self.connection.rollback()
            raise
        else:
            self.connection.commit()

    def initialize(self) -> None:
        current = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise LedgerError(
                f"state schema {current} is newer than supported schema {SCHEMA_VERSION}"
            )
        if current == SCHEMA_VERSION:
            return
        if current == 1:
            self._migrate_v1_to_v2()
            return
        if current != 0:
            raise LedgerError(f"no migration path from state schema {current}")

        with self.transaction() as db:
            db.executescript(
                """
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE catalog_papers (
                    arxiv_id TEXT PRIMARY KEY,
                    arxiv_version INTEGER CHECK (arxiv_version IS NULL OR arxiv_version > 0),
                    title TEXT NOT NULL,
                    authors_json TEXT NOT NULL,
                    published TEXT,
                    updated TEXT,
                    catalog_fingerprint TEXT NOT NULL,
                    bootstrapped_at TEXT NOT NULL
                );

                CREATE TABLE candidate_log_entries (
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version > 0),
                    metadata_sha256 TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    bootstrapped_at TEXT NOT NULL,
                    PRIMARY KEY (arxiv_id, version, metadata_sha256)
                );

                CREATE TABLE runs (
                    run_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    base_commit TEXT,
                    coverage_start TEXT,
                    coverage_end TEXT,
                    public_changes INTEGER,
                    summary_json TEXT
                );

                CREATE TABLE run_required_lanes (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    lane TEXT NOT NULL,
                    PRIMARY KEY (run_id, lane)
                );

                CREATE TABLE run_lanes (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    lane TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('completed', 'no_change', 'deferred', 'failed')
                    ),
                    detail_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, lane)
                );

                CREATE TABLE listing_batches (
                    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    source TEXT NOT NULL,
                    batch_key TEXT NOT NULL,
                    retrieved_at TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    ids_sha256 TEXT NOT NULL,
                    ids_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (source, batch_key, content_sha256)
                );

                CREATE TABLE listing_batch_ids (
                    batch_id INTEGER NOT NULL REFERENCES listing_batches(batch_id),
                    arxiv_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    PRIMARY KEY (batch_id, arxiv_id),
                    UNIQUE (batch_id, ordinal)
                );

                CREATE TABLE run_listing_batches (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    batch_id INTEGER NOT NULL REFERENCES listing_batches(batch_id),
                    observed_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, batch_id)
                );

                CREATE TABLE discoveries (
                    arxiv_id TEXT PRIMARY KEY,
                    first_seen_run_id TEXT NOT NULL REFERENCES runs(run_id),
                    first_seen_at TEXT NOT NULL
                );

                CREATE TABLE discovery_sources (
                    arxiv_id TEXT NOT NULL REFERENCES discoveries(arxiv_id),
                    batch_id INTEGER NOT NULL REFERENCES listing_batches(batch_id),
                    PRIMARY KEY (arxiv_id, batch_id)
                );

                CREATE TABLE paper_versions (
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version > 0),
                    title TEXT,
                    authors_json TEXT NOT NULL,
                    abstract TEXT,
                    submitted TEXT,
                    updated TEXT,
                    metadata_json TEXT NOT NULL,
                    metadata_sha256 TEXT NOT NULL,
                    first_seen_run_id TEXT NOT NULL REFERENCES runs(run_id),
                    last_seen_run_id TEXT NOT NULL REFERENCES runs(run_id),
                    screening_status TEXT NOT NULL CHECK (
                        screening_status IN ('pending', 'relevant', 'excluded', 'ambiguous')
                    ),
                    screening_reason TEXT,
                    reviewed_sha256 TEXT,
                    screened_at TEXT,
                    PRIMARY KEY (arxiv_id, version)
                );

                CREATE TABLE screening_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    decision TEXT NOT NULL CHECK (
                        decision IN ('relevant', 'excluded', 'ambiguous')
                    ),
                    reason TEXT,
                    metadata_sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (arxiv_id, version)
                        REFERENCES paper_versions(arxiv_id, version)
                );

                CREATE TABLE reference_snapshots (
                    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version > 0),
                    refs_sha256 TEXT NOT NULL,
                    refs_json TEXT NOT NULL,
                    source_url TEXT,
                    retrieved_at TEXT NOT NULL,
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    created_at TEXT NOT NULL,
                    UNIQUE (arxiv_id, version, refs_sha256)
                );

                CREATE TABLE reference_snapshot_ids (
                    snapshot_id INTEGER NOT NULL REFERENCES reference_snapshots(snapshot_id),
                    referenced_arxiv_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    PRIMARY KEY (snapshot_id, referenced_arxiv_id),
                    UNIQUE (snapshot_id, ordinal)
                );

                CREATE TABLE reference_heads (
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    snapshot_id INTEGER NOT NULL REFERENCES reference_snapshots(snapshot_id),
                    PRIMARY KEY (arxiv_id, version)
                );

                CREATE TABLE cursors (
                    lane TEXT NOT NULL,
                    cursor_key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    promoted_by_run_id TEXT NOT NULL REFERENCES runs(run_id),
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (lane, cursor_key)
                );

                CREATE TABLE cursor_updates (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    lane TEXT NOT NULL,
                    cursor_key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    staged_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, lane, cursor_key)
                );

                CREATE TABLE authors (
                    author_key TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    promoted_by_run_id TEXT NOT NULL REFERENCES runs(run_id),
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE author_registry (
                    author_key TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    source TEXT NOT NULL
                );

                CREATE TABLE author_cursor_updates (
                    run_id TEXT NOT NULL REFERENCES runs(run_id),
                    author_key TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    staged_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, author_key)
                );

                CREATE INDEX paper_versions_review_idx
                    ON paper_versions(screening_status, screened_at);
                CREATE INDEX listing_batch_ids_arxiv_idx
                    ON listing_batch_ids(arxiv_id);
                CREATE INDEX screening_events_paper_idx
                    ON screening_events(arxiv_id, version, created_at);
                CREATE INDEX reference_snapshot_paper_idx
                    ON reference_snapshots(arxiv_id, version, created_at);

                CREATE TRIGGER listing_batches_no_update
                BEFORE UPDATE ON listing_batches BEGIN
                    SELECT RAISE(ABORT, 'listing batches are immutable');
                END;
                CREATE TRIGGER listing_batches_no_delete
                BEFORE DELETE ON listing_batches BEGIN
                    SELECT RAISE(ABORT, 'listing batches are immutable');
                END;
                CREATE TRIGGER listing_batch_ids_no_update
                BEFORE UPDATE ON listing_batch_ids BEGIN
                    SELECT RAISE(ABORT, 'listing batch IDs are immutable');
                END;
                CREATE TRIGGER listing_batch_ids_no_delete
                BEFORE DELETE ON listing_batch_ids BEGIN
                    SELECT RAISE(ABORT, 'listing batch IDs are immutable');
                END;
                CREATE TRIGGER reference_snapshots_no_update
                BEFORE UPDATE ON reference_snapshots BEGIN
                    SELECT RAISE(ABORT, 'reference snapshots are immutable');
                END;
                CREATE TRIGGER reference_snapshots_no_delete
                BEFORE DELETE ON reference_snapshots BEGIN
                    SELECT RAISE(ABORT, 'reference snapshots are immutable');
                END;
                CREATE TRIGGER reference_snapshot_ids_no_update
                BEFORE UPDATE ON reference_snapshot_ids BEGIN
                    SELECT RAISE(ABORT, 'reference snapshot IDs are immutable');
                END;
                CREATE TRIGGER reference_snapshot_ids_no_delete
                BEFORE DELETE ON reference_snapshot_ids BEGIN
                    SELECT RAISE(ABORT, 'reference snapshot IDs are immutable');
                END;
                CREATE TRIGGER screening_events_no_update
                BEFORE UPDATE ON screening_events BEGIN
                    SELECT RAISE(ABORT, 'screening events are immutable');
                END;
                CREATE TRIGGER screening_events_no_delete
                BEFORE DELETE ON screening_events BEGIN
                    SELECT RAISE(ABORT, 'screening events are immutable');
                END;
                """
            )
            now = utc_now()
            db.execute(
                "INSERT INTO metadata(key, value_json, updated_at) VALUES (?, ?, ?)",
                ("schema_version", canonical_json(SCHEMA_VERSION), now),
            )
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _migrate_v1_to_v2(self) -> None:
        """Add exact catalog versions and durable ambiguous-publication state."""

        columns = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(catalog_papers)")
        }
        now = utc_now()
        with self.transaction() as db:
            if "arxiv_version" not in columns:
                db.execute(
                    """
                    ALTER TABLE catalog_papers
                    ADD COLUMN arxiv_version INTEGER
                    CHECK (arxiv_version IS NULL OR arxiv_version > 0)
                    """
                )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS candidate_log_entries (
                    arxiv_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version > 0),
                    metadata_sha256 TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    bootstrapped_at TEXT NOT NULL,
                    PRIMARY KEY (arxiv_id, version, metadata_sha256)
                )
                """
            )
            db.execute(
                """
                INSERT INTO metadata(key, value_json, updated_at)
                VALUES ('schema_version', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (canonical_json(SCHEMA_VERSION), now),
            )
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _ensure_initialized(self) -> None:
        version = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        if version != SCHEMA_VERSION:
            raise LedgerError("state is not initialized; run initialize first")

    def _require_running(self, db: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        row = db.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise LedgerError(f"unknown run: {run_id}")
        if row["status"] != "running":
            raise LedgerError(f"run {run_id} is {row['status']}, not running")
        return row

    def set_metadata(self, key: str, value: Any) -> None:
        self._ensure_initialized()
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO metadata(key, value_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (key, canonical_json(value), utc_now()),
            )

    def get_metadata(self, key: str, default: Any = None) -> Any:
        self._ensure_initialized()
        row = self.connection.execute(
            "SELECT value_json FROM metadata WHERE key = ?", (key,)
        ).fetchone()
        return default if row is None else json.loads(row["value_json"])

    def bootstrap_landscape(self, landscape_path: str | os.PathLike[str]) -> dict[str, Any]:
        """Import the current public catalog without inventing arXiv versions."""

        self._ensure_initialized()
        path = Path(landscape_path).expanduser().resolve()
        landscape = json.loads(path.read_text(encoding="utf-8"))
        papers = landscape.get("papers")
        if not isinstance(papers, list):
            raise LedgerError("landscape JSON does not contain a papers array")
        now = utc_now()
        imported: set[str] = set()
        with self.transaction() as db:
            active = db.execute(
                """
                SELECT run_id, started_at FROM runs
                WHERE status = 'running'
                ORDER BY started_at, run_id LIMIT 1
                """
            ).fetchone()
            if active is not None:
                raise ConflictError(
                    f"cannot bootstrap catalog while run {active['run_id']} is running "
                    f"since {active['started_at']}; recover it with abort-run first"
                )
            for paper in papers:
                arxiv_id, _ = normalize_arxiv_id(str(paper.get("arxivId") or paper["id"]))
                imported.add(arxiv_id)
                authors = paper.get("authors") or []
                baseline = {
                    "arxivId": arxiv_id,
                    "arxivVersion": catalog_arxiv_version(paper),
                    "title": paper.get("title") or "",
                    "authors": authors,
                    "published": paper.get("published"),
                    "updated": paper.get("updated"),
                }
                db.execute(
                    """
                    INSERT INTO catalog_papers(
                        arxiv_id, arxiv_version, title, authors_json, published, updated,
                        catalog_fingerprint, bootstrapped_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(arxiv_id) DO UPDATE SET
                        arxiv_version = excluded.arxiv_version,
                        title = excluded.title,
                        authors_json = excluded.authors_json,
                        published = excluded.published,
                        updated = excluded.updated,
                        catalog_fingerprint = excluded.catalog_fingerprint,
                        bootstrapped_at = excluded.bootstrapped_at
                    """,
                    (
                        arxiv_id,
                        baseline["arxivVersion"],
                        baseline["title"],
                        canonical_json(authors),
                        baseline["published"],
                        baseline["updated"],
                        sha256_json(baseline),
                        now,
                    ),
                )
                if baseline["arxivVersion"] is not None:
                    db.execute(
                        """
                        UPDATE paper_versions SET
                            screening_status = 'relevant',
                            screening_reason = 'present in versioned public catalog',
                            reviewed_sha256 = metadata_sha256,
                            screened_at = COALESCE(screened_at, ?)
                        WHERE arxiv_id = ? AND version <= ?
                        """,
                        (now, arxiv_id, baseline["arxivVersion"]),
                    )
                for author in authors:
                    author_key = normalize_author(str(author))
                    if author_key:
                        db.execute(
                            """
                            INSERT OR IGNORE INTO author_registry(
                                author_key, display_name, first_seen_at, source
                            ) VALUES (?, ?, ?, 'catalog')
                            """,
                            (author_key, " ".join(str(author).split()), now),
                        )
            if imported:
                placeholders = ",".join("?" for _ in imported)
                db.execute(
                    f"DELETE FROM catalog_papers WHERE arxiv_id NOT IN ({placeholders})",
                    tuple(sorted(imported)),
                )
            else:
                db.execute("DELETE FROM catalog_papers")
            metadata_values = {
                "landscape_path": str(path),
                "catalog_updated_at": landscape.get("updatedAt"),
                "catalog_last_successful_scan": landscape.get("lastSuccessfulScan"),
                "catalog_sha256": sha256_bytes(path.read_bytes()),
                "catalog_paper_count": len(imported),
            }
            for key, value in metadata_values.items():
                db.execute(
                    """
                    INSERT INTO metadata(key, value_json, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json = excluded.value_json,
                        updated_at = excluded.updated_at
                    """,
                    (key, canonical_json(value), now),
                )
        return {
            "catalogPapers": len(imported),
            "catalogUpdatedAt": landscape.get("updatedAt"),
            "lastSuccessfulScan": landscape.get("lastSuccessfulScan"),
            "state": str(self.path),
        }

    def bootstrap_candidate_log(
        self, candidates_path: str | os.PathLike[str]
    ) -> dict[str, Any]:
        """Import exact ambiguous-version identities from the public candidate log."""

        self._ensure_initialized()
        path = Path(candidates_path).expanduser().resolve()
        document = json.loads(path.read_text(encoding="utf-8"))
        items = document.get("items") if isinstance(document, dict) else None
        if not isinstance(items, list):
            raise LedgerError("candidate log JSON does not contain an items array")
        parsed: list[tuple[str, int, str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                raise LedgerError("candidate log items must be JSON objects")
            raw_id = item.get("arxivId") or item.get("id")
            if not raw_id:
                raise LedgerError("candidate log item is missing arxivId")
            identifier, embedded_version = normalize_arxiv_id(str(raw_id))
            raw_version = item.get("version", embedded_version)
            if isinstance(raw_version, bool):
                raise LedgerError("candidate log item version must be a positive integer")
            try:
                version = int(raw_version)
            except (TypeError, ValueError) as error:
                raise LedgerError(
                    "candidate log item version must be a positive integer"
                ) from error
            if version <= 0 or (
                embedded_version is not None and embedded_version != version
            ):
                raise LedgerError("candidate log item has an invalid or conflicting version")
            digest = item.get("metadataSha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise LedgerError(
                    "candidate log item metadataSha256 must be a lowercase SHA-256 digest"
                )
            if item.get("status") != "ambiguous":
                raise LedgerError("candidate log item status must be 'ambiguous'")
            parsed.append((identifier, version, digest, canonical_json(item)))
        now = utc_now()
        with self.transaction() as db:
            active = db.execute(
                """
                SELECT run_id, started_at FROM runs
                WHERE status = 'running'
                ORDER BY started_at, run_id LIMIT 1
                """
            ).fetchone()
            if active is not None:
                raise ConflictError(
                    f"cannot bootstrap candidate log while run {active['run_id']} "
                    f"is running since {active['started_at']}; recover it with "
                    "abort-run first"
                )
            db.execute("DELETE FROM candidate_log_entries")
            db.executemany(
                """
                INSERT INTO candidate_log_entries(
                    arxiv_id, version, metadata_sha256, payload_json, bootstrapped_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                ((*entry, now) for entry in parsed),
            )
            db.execute(
                """
                INSERT INTO metadata(key, value_json, updated_at)
                VALUES ('candidate_log_sha256', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (canonical_json(sha256_bytes(path.read_bytes())), now),
            )
        return {"candidateLogEntries": len(parsed), "candidateLogPath": str(path)}

    def start_run(
        self,
        *,
        kind: str = "daily",
        base_commit: str | None = None,
        started_at: str | None = None,
        coverage_start: str | None = None,
        coverage_end: str | None = None,
        required_lanes: Sequence[str] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        self._ensure_initialized()
        identifier = run_id or str(uuid.uuid4())
        lanes = tuple(dict.fromkeys(required_lanes or DEFAULT_REQUIRED_LANES))
        normalized_kind = kind.strip()
        if not normalized_kind:
            raise ValueError("run kind cannot be empty")
        if normalized_kind == "daily" and (
            coverage_start is None or coverage_end is None
        ):
            raise ValueError(
                "daily runs require both coverage_start and coverage_end"
            )
        if (coverage_start is None) != (coverage_end is None):
            raise ValueError("coverage_start and coverage_end must be supplied together")
        if coverage_start is not None and coverage_end is not None:
            coverage_start = _iso_date(coverage_start, "coverage_start")
            coverage_end = _iso_date(coverage_end, "coverage_end")
            if coverage_start > coverage_end:
                raise ValueError("coverage_start must not be after coverage_end")
        with self.transaction() as db:
            active = db.execute(
                """
                SELECT run_id, started_at FROM runs
                WHERE status = 'running'
                ORDER BY started_at, run_id
                LIMIT 1
                """
            ).fetchone()
            if active is not None:
                raise ConflictError(
                    f"run {active['run_id']} is already running since "
                    f"{active['started_at']}; recover it with abort-run before starting another"
                )
            db.execute(
                """
                INSERT INTO runs(
                    run_id, kind, status, started_at, base_commit,
                    coverage_start, coverage_end
                ) VALUES (?, ?, 'running', ?, ?, ?, ?)
                """,
                (
                    identifier,
                    normalized_kind,
                    started_at or utc_now(),
                    base_commit,
                    coverage_start,
                    coverage_end,
                ),
            )
            db.executemany(
                "INSERT INTO run_required_lanes(run_id, lane) VALUES (?, ?)",
                ((identifier, lane) for lane in lanes),
            )
        return {
            "runId": identifier,
            "kind": normalized_kind,
            "requiredLanes": list(lanes),
            "plannedCoverage": (
                {"start": coverage_start, "end": coverage_end}
                if coverage_start is not None
                else None
            ),
        }

    def set_lane(
        self, run_id: str, lane: str, status: str, detail: Any | None = None
    ) -> None:
        self._ensure_initialized()
        if status not in LANE_STATES:
            raise ValueError(f"invalid lane status: {status}")
        with self.transaction() as db:
            self._require_running(db, run_id)
            db.execute(
                """
                INSERT INTO run_lanes(run_id, lane, status, detail_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id, lane) DO UPDATE SET
                    status = excluded.status,
                    detail_json = excluded.detail_json,
                    updated_at = excluded.updated_at
                """,
                (run_id, lane, status, canonical_json(detail or {}), utc_now()),
            )

    def record_listing_batch(
        self,
        *,
        run_id: str,
        source: str,
        batch_key: str,
        ids: Iterable[str],
        retrieved_at: str | None = None,
        payload: bytes | None = None,
        discover: bool = True,
    ) -> dict[str, Any]:
        """Record an immutable source snapshot and its versionless IDs.

        Replaying exactly the same snapshot is idempotent.  If a source page
        changes under the same semantic batch key, a second immutable snapshot
        is retained with its own content hash.  ``discover=False`` retains the
        complete batch as coverage evidence without adding its IDs to the
        candidate queue.  A later replay with discovery enabled can promote
        those IDs without duplicating the immutable batch.
        """

        self._ensure_initialized()
        normalized = canonical_arxiv_ids(ids)
        ids_json = canonical_json(normalized)
        ids_hash = sha256_bytes(ids_json.encode("utf-8"))
        content_hash = sha256_bytes(payload if payload is not None else ids_json.encode("utf-8"))
        now = utc_now()
        with self.transaction() as db:
            self._require_running(db, run_id)
            existing = db.execute(
                """
                SELECT * FROM listing_batches
                WHERE source = ? AND batch_key = ? AND content_sha256 = ?
                """,
                (source, batch_key, content_hash),
            ).fetchone()
            if existing is not None:
                if existing["ids_sha256"] != ids_hash:
                    raise ConflictError(
                        "the same listing payload was parsed into a different ID set"
                    )
                db.execute(
                    """
                    INSERT OR IGNORE INTO run_listing_batches(run_id, batch_id, observed_at)
                    VALUES (?, ?, ?)
                    """,
                    (run_id, existing["batch_id"], now),
                )
                discoveries_recorded = (
                    self._record_batch_discoveries(
                        db, run_id, int(existing["batch_id"]), normalized, now
                    )
                    if discover
                    else 0
                )
                return {
                    "batchId": existing["batch_id"],
                    "contentSha256": content_hash,
                    "idsSha256": ids_hash,
                    "idCount": len(normalized),
                    "discover": discover,
                    "discoveriesRecorded": discoveries_recorded,
                    "replayed": True,
                }
            cursor = db.execute(
                """
                INSERT INTO listing_batches(
                    run_id, source, batch_key, retrieved_at, content_sha256,
                    ids_sha256, ids_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    source,
                    batch_key,
                    retrieved_at or now,
                    content_hash,
                    ids_hash,
                    ids_json,
                    now,
                ),
            )
            batch_id = int(cursor.lastrowid)
            db.execute(
                """
                INSERT INTO run_listing_batches(run_id, batch_id, observed_at)
                VALUES (?, ?, ?)
                """,
                (run_id, batch_id, now),
            )
            for ordinal, arxiv_id in enumerate(normalized):
                db.execute(
                    """
                    INSERT INTO listing_batch_ids(batch_id, arxiv_id, ordinal)
                    VALUES (?, ?, ?)
                    """,
                    (batch_id, arxiv_id, ordinal),
                )
            discoveries_recorded = (
                self._record_batch_discoveries(db, run_id, batch_id, normalized, now)
                if discover
                else 0
            )
        return {
            "batchId": batch_id,
            "contentSha256": content_hash,
            "idsSha256": ids_hash,
            "idCount": len(normalized),
            "discover": discover,
            "discoveriesRecorded": discoveries_recorded,
            "replayed": False,
        }

    @staticmethod
    def _record_batch_discoveries(
        db: sqlite3.Connection,
        run_id: str,
        batch_id: int,
        identifiers: Sequence[str],
        observed_at: str,
    ) -> int:
        inserted = 0
        for arxiv_id in identifiers:
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO discoveries(arxiv_id, first_seen_run_id, first_seen_at)
                VALUES (?, ?, ?)
                """,
                (arxiv_id, run_id, observed_at),
            )
            inserted += max(0, cursor.rowcount)
            db.execute(
                """
                INSERT OR IGNORE INTO discovery_sources(arxiv_id, batch_id) VALUES (?, ?)
                """,
                (arxiv_id, batch_id),
            )
        return inserted

    def observe_paper(
        self,
        *,
        run_id: str,
        arxiv_id: str,
        version: int,
        metadata: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Insert or refresh one arXiv version and mark changed metadata pending."""

        self._ensure_initialized()
        identifier, embedded_version = normalize_arxiv_id(arxiv_id)
        if embedded_version is not None and embedded_version != version:
            raise ValueError("version argument conflicts with version in arXiv ID")
        if version <= 0:
            raise ValueError("version must be positive")
        document = dict(metadata)
        document["arxivId"] = identifier
        document["version"] = version
        authors = document.get("authors") or []
        if not isinstance(authors, list):
            raise ValueError("metadata authors must be an array")
        digest = sha256_json(_metadata_for_hash(document))
        now = utc_now()
        with self.transaction() as db:
            self._require_running(db, run_id)
            existing = db.execute(
                "SELECT * FROM paper_versions WHERE arxiv_id = ? AND version = ?",
                (identifier, version),
            ).fetchone()
            catalog = db.execute(
                "SELECT * FROM catalog_papers WHERE arxiv_id = ?", (identifier,)
            ).fetchone()
            observed_updated = document.get("updated")
            covered_by_catalog = bool(
                catalog is not None
                and catalog["arxiv_version"] is not None
                and version <= int(catalog["arxiv_version"])
            )
            if existing is None:
                status = "relevant" if covered_by_catalog else "pending"
                reviewed = digest if covered_by_catalog else None
                reason = "present in bootstrapped public catalog" if covered_by_catalog else None
                screened_at = now if covered_by_catalog else None
                db.execute(
                    """
                    INSERT INTO paper_versions(
                        arxiv_id, version, title, authors_json, abstract, submitted,
                        updated, metadata_json, metadata_sha256, first_seen_run_id,
                        last_seen_run_id, screening_status, screening_reason,
                        reviewed_sha256, screened_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        identifier,
                        version,
                        document.get("title"),
                        canonical_json(authors),
                        document.get("abstract"),
                        document.get("submitted") or document.get("published"),
                        observed_updated,
                        canonical_json(document),
                        digest,
                        run_id,
                        run_id,
                        status,
                        reason,
                        reviewed,
                        screened_at,
                    ),
                )
                changed = True
            else:
                changed = existing["metadata_sha256"] != digest
                if changed:
                    status = "pending"
                    reason = "metadata changed since last review"
                    reviewed = existing["reviewed_sha256"]
                    screened_at = existing["screened_at"]
                else:
                    status = existing["screening_status"]
                    reason = existing["screening_reason"]
                    reviewed = existing["reviewed_sha256"]
                    screened_at = existing["screened_at"]
                db.execute(
                    """
                    UPDATE paper_versions SET
                        title = ?, authors_json = ?, abstract = ?, submitted = ?,
                        updated = ?, metadata_json = ?, metadata_sha256 = ?,
                        last_seen_run_id = ?, screening_status = ?,
                        screening_reason = ?, reviewed_sha256 = ?, screened_at = ?
                    WHERE arxiv_id = ? AND version = ?
                    """,
                    (
                        document.get("title"),
                        canonical_json(authors),
                        document.get("abstract"),
                        document.get("submitted") or document.get("published"),
                        observed_updated,
                        canonical_json(document),
                        digest,
                        run_id,
                        status,
                        reason,
                        reviewed,
                        screened_at,
                        identifier,
                        version,
                    ),
                )
            db.execute(
                """
                INSERT OR IGNORE INTO discoveries(arxiv_id, first_seen_run_id, first_seen_at)
                VALUES (?, ?, ?)
                """,
                (identifier, run_id, now),
            )
        return {
            "arxivId": identifier,
            "version": version,
            "metadataSha256": digest,
            "changed": changed,
            "screeningStatus": status,
        }

    def screen_paper(
        self,
        *,
        run_id: str,
        arxiv_id: str,
        version: int,
        decision: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        self._ensure_initialized()
        if decision not in FINAL_SCREENING_STATES:
            raise ValueError(f"invalid final screening decision: {decision}")
        identifier, embedded_version = normalize_arxiv_id(arxiv_id)
        if embedded_version is not None and embedded_version != version:
            raise ValueError("version argument conflicts with version in arXiv ID")
        now = utc_now()
        with self.transaction() as db:
            self._require_running(db, run_id)
            row = db.execute(
                "SELECT * FROM paper_versions WHERE arxiv_id = ? AND version = ?",
                (identifier, version),
            ).fetchone()
            if row is None:
                raise LedgerError("observe the paper version before screening it")
            db.execute(
                """
                UPDATE paper_versions SET
                    screening_status = ?, screening_reason = ?,
                    reviewed_sha256 = metadata_sha256, screened_at = ?
                WHERE arxiv_id = ? AND version = ?
                """,
                (decision, reason, now, identifier, version),
            )
            if decision == "relevant":
                for author in json.loads(row["authors_json"]):
                    author_key = normalize_author(str(author))
                    if author_key:
                        db.execute(
                            """
                            INSERT OR IGNORE INTO author_registry(
                                author_key, display_name, first_seen_at, source
                            ) VALUES (?, ?, ?, 'relevant-paper')
                            """,
                            (author_key, " ".join(str(author).split()), now),
                        )
            event = db.execute(
                """
                INSERT INTO screening_events(
                    arxiv_id, version, run_id, decision, reason,
                    metadata_sha256, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    version,
                    run_id,
                    decision,
                    reason,
                    row["metadata_sha256"],
                    now,
                ),
            )
        return {
            "eventId": int(event.lastrowid),
            "arxivId": identifier,
            "version": version,
            "decision": decision,
        }

    def record_reference_snapshot(
        self,
        *,
        run_id: str,
        arxiv_id: str,
        version: int,
        references: Iterable[str],
        source_url: str | None = None,
        retrieved_at: str | None = None,
        supersede: bool = False,
    ) -> dict[str, Any]:
        """Store a complete immutable bibliography and promote it as the head.

        A corrected extraction for the same paper version requires
        ``supersede=True``.  The old immutable snapshot remains available.
        """

        return self.record_reference_snapshots_batch(
            run_id=run_id,
            snapshots=(
                {
                    "arxiv_id": arxiv_id,
                    "version": version,
                    "references": list(references),
                    "source_url": source_url,
                    "retrieved_at": retrieved_at,
                },
            ),
            supersede=supersede,
        )[0]

    def record_reference_snapshots_batch(
        self,
        *,
        run_id: str,
        snapshots: Iterable[Mapping[str, Any]],
        supersede: bool = False,
    ) -> list[dict[str, Any]]:
        """Atomically store and promote a batch of complete bibliographies.

        Every input and existing-head conflict is checked before the enclosing
        transaction commits.  A failure on any paper therefore leaves every
        snapshot/head in the batch unchanged.
        """

        self._ensure_initialized()
        prepared: list[dict[str, Any]] = []
        seen: set[tuple[str, int]] = set()
        for item in snapshots:
            if not isinstance(item, Mapping):
                raise ValueError("every reference snapshot must be a mapping")
            if "arxiv_id" not in item or "version" not in item:
                raise ValueError("every reference snapshot needs arxiv_id and version")
            identifier, embedded_version = normalize_arxiv_id(str(item["arxiv_id"]))
            if isinstance(item["version"], bool):
                raise ValueError("version must be positive")
            try:
                version = int(item["version"])
            except (TypeError, ValueError) as error:
                raise ValueError("version must be positive") from error
            if embedded_version is not None and embedded_version != version:
                raise ValueError("version argument conflicts with version in arXiv ID")
            if version <= 0:
                raise ValueError("version must be positive")
            key = (identifier, version)
            if key in seen:
                raise ValueError(
                    f"duplicate reference snapshot in batch: {identifier}v{version}"
                )
            seen.add(key)
            references = item.get("references", ())
            if isinstance(references, (str, bytes)):
                raise ValueError("references must be an iterable of arXiv IDs")
            refs = canonical_arxiv_ids(references)
            refs_json = canonical_json(refs)
            prepared.append(
                {
                    "identifier": identifier,
                    "version": version,
                    "refs": refs,
                    "refs_json": refs_json,
                    "digest": sha256_bytes(refs_json.encode("utf-8")),
                    "source_url": item.get("source_url"),
                    "retrieved_at": item.get("retrieved_at"),
                }
            )

        now = utc_now()
        results: list[dict[str, Any]] = []
        with self.transaction() as db:
            self._require_running(db, run_id)
            for item in prepared:
                identifier = item["identifier"]
                version = item["version"]
                digest = item["digest"]
                refs = item["refs"]
                head = db.execute(
                    """
                    SELECT h.snapshot_id, s.refs_sha256
                    FROM reference_heads h
                    JOIN reference_snapshots s ON s.snapshot_id = h.snapshot_id
                    WHERE h.arxiv_id = ? AND h.version = ?
                    """,
                    (identifier, version),
                ).fetchone()
                if head is not None and head["refs_sha256"] != digest and not supersede:
                    raise ConflictError(
                        f"{identifier}v{version} already has a different complete "
                        "reference snapshot; pass supersede=True to retain both and "
                        "promote the correction"
                    )
                snapshot = db.execute(
                    """
                    SELECT snapshot_id FROM reference_snapshots
                    WHERE arxiv_id = ? AND version = ? AND refs_sha256 = ?
                    """,
                    (identifier, version, digest),
                ).fetchone()
                replayed = snapshot is not None
                if snapshot is None:
                    inserted = db.execute(
                        """
                        INSERT INTO reference_snapshots(
                            arxiv_id, version, refs_sha256, refs_json, source_url,
                            retrieved_at, run_id, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            identifier,
                            version,
                            digest,
                            item["refs_json"],
                            item["source_url"],
                            item["retrieved_at"] or now,
                            run_id,
                            now,
                        ),
                    )
                    snapshot_id = int(inserted.lastrowid)
                    db.executemany(
                        """
                        INSERT INTO reference_snapshot_ids(
                            snapshot_id, referenced_arxiv_id, ordinal
                        ) VALUES (?, ?, ?)
                        """,
                        (
                            (snapshot_id, ref, ordinal)
                            for ordinal, ref in enumerate(refs)
                        ),
                    )
                else:
                    snapshot_id = int(snapshot["snapshot_id"])
                db.execute(
                    """
                    INSERT INTO reference_heads(arxiv_id, version, snapshot_id)
                    VALUES (?, ?, ?)
                    ON CONFLICT(arxiv_id, version) DO UPDATE SET
                        snapshot_id = excluded.snapshot_id
                    """,
                    (identifier, version, snapshot_id),
                )
                results.append(
                    {
                        "snapshotId": snapshot_id,
                        "arxivId": identifier,
                        "version": version,
                        "refsSha256": digest,
                        "referenceCount": len(refs),
                        "replayed": replayed,
                    }
                )
        return results

    def mapped_citations(self, mapped_ids: Iterable[str]) -> dict[str, Any]:
        """Derive map edges from each paper's latest complete bibliography.

        Reference snapshots retain every explicit arXiv ID.  Intersecting them
        at read time means adding an older paper to the map immediately reveals
        already-recorded papers that cite it, without downloading bibliographies
        again.
        """

        self._ensure_initialized()
        identifiers = canonical_arxiv_ids(mapped_ids)
        mapped = set(identifiers)
        heads: dict[str, dict[int, sqlite3.Row]] = {}
        for row in self.connection.execute(
            """
            SELECT h.arxiv_id, h.version, h.snapshot_id, s.refs_sha256,
                   s.retrieved_at, s.source_url
            FROM reference_heads h
            JOIN reference_snapshots s ON s.snapshot_id = h.snapshot_id
            ORDER BY h.arxiv_id, h.version
            """
        ):
            if row["arxiv_id"] in mapped:
                heads.setdefault(row["arxiv_id"], {})[int(row["version"])] = row
        expected_versions = {
            row["arxiv_id"]: int(row["version"])
            for row in self.connection.execute(
                """
                SELECT arxiv_id, MAX(version) AS version
                FROM paper_versions
                GROUP BY arxiv_id
                """
            )
            if row["arxiv_id"] in mapped
        }
        for row in self.connection.execute(
            """
            SELECT arxiv_id, arxiv_version
            FROM catalog_papers
            WHERE arxiv_version IS NOT NULL
            """
        ):
            if row["arxiv_id"] in mapped:
                expected_versions[row["arxiv_id"]] = max(
                    expected_versions.get(row["arxiv_id"], 0),
                    int(row["arxiv_version"]),
                )

        selected: dict[str, sqlite3.Row] = {}
        missing: list[str] = []
        stale: list[str] = []
        unknown_version: list[str] = []
        provenance: dict[str, dict[str, Any] | None] = {}
        for identifier in identifiers:
            expected_version = expected_versions.get(identifier)
            available = heads.get(identifier, {})
            exact = available.get(expected_version) if expected_version is not None else None
            if exact is not None:
                selected[identifier] = exact
                provenance[identifier] = {
                    "version": exact["version"],
                    "expectedVersion": expected_version,
                    "availableVersions": sorted(available),
                    "stale": False,
                    "snapshotId": exact["snapshot_id"],
                    "refsSha256": exact["refs_sha256"],
                    "retrievedAt": exact["retrieved_at"],
                    "sourceUrl": exact["source_url"],
                }
                continue
            if expected_version is None:
                unknown_version.append(identifier)
            if not available:
                missing.append(identifier)
                provenance[identifier] = None
                continue
            fallback = available[max(available)]
            stale.append(identifier)
            provenance[identifier] = {
                "version": fallback["version"],
                "expectedVersion": expected_version,
                "availableVersions": sorted(available),
                "stale": True,
                "snapshotId": fallback["snapshot_id"],
                "refsSha256": fallback["refs_sha256"],
                "retrievedAt": fallback["retrieved_at"],
                "sourceUrl": fallback["source_url"],
            }

        refs_by_snapshot: dict[int, list[str]] = {}
        if selected:
            snapshot_ids = sorted({int(row["snapshot_id"]) for row in selected.values()})
            placeholders = ",".join("?" for _ in snapshot_ids)
            for row in self.connection.execute(
                f"""
                SELECT snapshot_id, referenced_arxiv_id
                FROM reference_snapshot_ids
                WHERE snapshot_id IN ({placeholders})
                ORDER BY snapshot_id, ordinal
                """,
                tuple(snapshot_ids),
            ):
                refs_by_snapshot.setdefault(int(row["snapshot_id"]), []).append(
                    row["referenced_arxiv_id"]
                )

        outgoing: dict[str, list[str]] = {}
        cited_by: dict[str, list[str]] = {identifier: [] for identifier in identifiers}
        edge_count = 0
        for identifier in identifiers:
            snapshot = selected.get(identifier)
            if snapshot is None:
                outgoing[identifier] = []
                continue
            references = sorted(
                ref
                for ref in refs_by_snapshot.get(int(snapshot["snapshot_id"]), [])
                if ref in mapped and ref != identifier
            )
            outgoing[identifier] = references
            edge_count += len(references)
            for referenced in references:
                cited_by[referenced].append(identifier)
        for identifier in cited_by:
            cited_by[identifier].sort()
        return {
            "schemaVersion": 1,
            "generatedAt": utc_now(),
            "mappedIds": identifiers,
            "coverageComplete": not missing and not stale and not unknown_version,
            "missingSnapshotIds": missing,
            "staleSnapshotIds": stale,
            "unknownVersionIds": unknown_version,
            "edgeCount": edge_count,
            "outgoing": outgoing,
            "citedBy": cited_by,
            "citationCounts": {
                identifier: len(cited_by[identifier]) for identifier in identifiers
            },
            "snapshotProvenance": provenance,
        }

    def stage_cursor(
        self, *, run_id: str, lane: str, key: str, value: Any
    ) -> dict[str, Any]:
        self._ensure_initialized()
        if not lane.strip() or not key.strip():
            raise ValueError("cursor lane and key cannot be empty")
        now = utc_now()
        with self.transaction() as db:
            self._require_running(db, run_id)
            db.execute(
                """
                INSERT INTO cursor_updates(run_id, lane, cursor_key, value_json, staged_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id, lane, cursor_key) DO UPDATE SET
                    value_json = excluded.value_json,
                    staged_at = excluded.staged_at
                """,
                (run_id, lane.strip(), key.strip(), canonical_json(value), now),
            )
        return {"runId": run_id, "lane": lane.strip(), "key": key.strip(), "staged": True}

    def stage_author_cursor(
        self, *, run_id: str, author: str, value: Any
    ) -> dict[str, Any]:
        self._ensure_initialized()
        key = normalize_author(author)
        if not key:
            raise ValueError("author cannot be empty")
        now = utc_now()
        with self.transaction() as db:
            self._require_running(db, run_id)
            db.execute(
                """
                INSERT OR IGNORE INTO author_registry(
                    author_key, display_name, first_seen_at, source
                ) VALUES (?, ?, ?, 'explicit-cursor')
                """,
                (key, " ".join(author.split()), now),
            )
            db.execute(
                """
                INSERT INTO author_cursor_updates(
                    run_id, author_key, display_name, value_json, staged_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id, author_key) DO UPDATE SET
                    display_name = excluded.display_name,
                    value_json = excluded.value_json,
                    staged_at = excluded.staged_at
                """,
                (run_id, key, " ".join(author.split()), canonical_json(value), now),
            )
        return {"runId": run_id, "authorKey": key, "staged": True}

    def get_cursor(self, lane: str, key: str) -> Any | None:
        self._ensure_initialized()
        row = self.connection.execute(
            "SELECT value_json FROM cursors WHERE lane = ? AND cursor_key = ?",
            (lane, key),
        ).fetchone()
        return None if row is None else json.loads(row["value_json"])

    def planned_coverage(self, run_id: str) -> dict[str, str] | None:
        """Return the immutable coverage interval bound when a run was started."""

        self._ensure_initialized()
        row = self.connection.execute(
            "SELECT coverage_start, coverage_end FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if row is None:
            raise LedgerError(f"unknown run: {run_id}")
        if row["coverage_start"] is None or row["coverage_end"] is None:
            return None
        return {"start": row["coverage_start"], "end": row["coverage_end"]}

    def get_author_cursor(self, author: str) -> Any | None:
        """Read a committed author-search frontier using normalized identity."""

        self._ensure_initialized()
        key = normalize_author(author)
        row = self.connection.execute(
            "SELECT value_json FROM authors WHERE author_key = ?", (key,)
        ).fetchone()
        return None if row is None else json.loads(row["value_json"])

    def known_papers(self) -> dict[str, dict[str, Any]]:
        """Return compact catalog/discovery/version frontiers for collectors."""

        self._ensure_initialized()
        catalog = {
            row["arxiv_id"]: {
                "updated": row["updated"],
                "version": row["arxiv_version"],
            }
            for row in self.connection.execute(
                """
                SELECT arxiv_id, arxiv_version, updated
                FROM catalog_papers ORDER BY arxiv_id
                """
            )
        }
        identifiers = set(catalog)
        identifiers.update(
            row["arxiv_id"]
            for row in self.connection.execute("SELECT arxiv_id FROM discoveries")
        )
        versions_by_id: dict[str, list[dict[str, Any]]] = {}
        for row in self.connection.execute(
            """
            SELECT arxiv_id, version, metadata_sha256, updated, screening_status
            FROM paper_versions ORDER BY arxiv_id, version
            """
        ):
            versions_by_id.setdefault(row["arxiv_id"], []).append(
                {
                    "version": row["version"],
                    "metadataSha256": row["metadata_sha256"],
                    "updated": row["updated"],
                    "screeningStatus": row["screening_status"],
                }
            )
        result: dict[str, dict[str, Any]] = {}
        for identifier in sorted(identifiers):
            result[identifier] = {
                "inCatalog": identifier in catalog,
                "catalogUpdated": (
                    catalog[identifier]["updated"] if identifier in catalog else None
                ),
                "catalogVersion": (
                    catalog[identifier]["version"] if identifier in catalog else None
                ),
                "versions": versions_by_id.get(identifier, []),
            }
        return result

    def missing_relevant_reference_targets(self) -> list[dict[str, Any]]:
        """Return accepted unpublished versions lacking an exact snapshot.

        This is the compact bibliography work queue used by the reference
        harvester.  Its predicate deliberately matches the completion gate so
        the collector and final run validation cannot disagree about which
        accepted versions still need complete reference evidence.
        """

        self._ensure_initialized()
        rows = self.connection.execute(
            """
            SELECT p.arxiv_id, p.version
            FROM paper_versions p
            LEFT JOIN catalog_papers c ON c.arxiv_id = p.arxiv_id
            LEFT JOIN reference_heads h
              ON h.arxiv_id = p.arxiv_id AND h.version = p.version
            WHERE p.screening_status = 'relevant'
              AND p.reviewed_sha256 = p.metadata_sha256
              AND (
                  c.arxiv_id IS NULL
                  OR c.arxiv_version IS NULL
                  OR c.arxiv_version < p.version
              )
              AND h.snapshot_id IS NULL
            ORDER BY p.arxiv_id, p.version
            """
        ).fetchall()
        return [
            {"arxivId": row["arxiv_id"], "version": int(row["version"])}
            for row in rows
        ]

    def review_bundle(self, limit: int = 200) -> dict[str, Any]:
        """Return only new or changed paper versions, plus unhydrated IDs."""

        self._ensure_initialized()
        if limit <= 0:
            raise ValueError("limit must be positive")
        rows = self.connection.execute(
            """
            SELECT p.*, c.arxiv_id IS NOT NULL AS in_catalog,
                   c.arxiv_version AS catalog_version
            FROM paper_versions p
            LEFT JOIN catalog_papers c ON c.arxiv_id = p.arxiv_id
            WHERE p.screening_status = 'pending'
               OR p.reviewed_sha256 IS NULL
               OR p.reviewed_sha256 <> p.metadata_sha256
               OR (
                   p.screening_status = 'relevant'
                   AND (
                       c.arxiv_id IS NULL
                       OR c.arxiv_version IS NULL
                       OR c.arxiv_version < p.version
                   )
               )
               OR (
                   p.screening_status = 'ambiguous'
                   AND NOT EXISTS (
                       SELECT 1 FROM candidate_log_entries l
                       WHERE l.arxiv_id = p.arxiv_id
                         AND l.version = p.version
                         AND l.metadata_sha256 = p.metadata_sha256
                   )
               )
            ORDER BY COALESCE(p.updated, p.submitted, ''), p.arxiv_id, p.version
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        candidates: list[dict[str, Any]] = []
        for row in rows:
            prior = self.connection.execute(
                """
                SELECT MAX(version) AS latest
                FROM paper_versions
                WHERE arxiv_id = ? AND version < ? AND reviewed_sha256 IS NOT NULL
                """,
                (row["arxiv_id"], row["version"]),
            ).fetchone()["latest"]
            if row["screening_status"] == "relevant" and not row["in_catalog"]:
                reason = "accepted_unpublished"
            elif row["screening_status"] == "relevant":
                reason = "accepted_revision_unpublished"
            elif row["screening_status"] == "ambiguous":
                reason = "ambiguous_unpublished"
            elif row["reviewed_sha256"] and row["reviewed_sha256"] != row["metadata_sha256"]:
                reason = "metadata_changed"
            elif prior is not None or row["in_catalog"]:
                reason = "new_version"
            else:
                reason = "new_paper"
            candidates.append(
                {
                    "arxivId": row["arxiv_id"],
                    "version": row["version"],
                    "reason": reason,
                    "screeningStatus": row["screening_status"],
                    "metadataSha256": row["metadata_sha256"],
                    "metadata": json.loads(row["metadata_json"]),
                    "sources": self._sources_for(row["arxiv_id"]),
                }
            )
        remaining = max(0, limit - len(candidates))
        unhydrated: list[dict[str, Any]] = []
        if remaining:
            missing = self.connection.execute(
                """
                SELECT d.arxiv_id, d.first_seen_at
                FROM discoveries d
                LEFT JOIN catalog_papers c ON c.arxiv_id = d.arxiv_id
                WHERE c.arxiv_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM paper_versions p WHERE p.arxiv_id = d.arxiv_id
                  )
                ORDER BY d.first_seen_at, d.arxiv_id
                LIMIT ?
                """,
                (remaining,),
            ).fetchall()
            unhydrated = [
                {
                    "arxivId": row["arxiv_id"],
                    "reason": "metadata_required",
                    "sources": self._sources_for(row["arxiv_id"]),
                }
                for row in missing
            ]
        total_review = int(
            self.connection.execute(
                """
                SELECT COUNT(*)
                FROM paper_versions p
                LEFT JOIN catalog_papers c ON c.arxiv_id = p.arxiv_id
                WHERE p.screening_status = 'pending'
                   OR p.reviewed_sha256 IS NULL
                   OR p.reviewed_sha256 <> p.metadata_sha256
                   OR (
                       p.screening_status = 'relevant'
                       AND (
                           c.arxiv_id IS NULL
                           OR c.arxiv_version IS NULL
                           OR c.arxiv_version < p.version
                       )
                   )
                   OR (
                       p.screening_status = 'ambiguous'
                       AND NOT EXISTS (
                           SELECT 1 FROM candidate_log_entries l
                           WHERE l.arxiv_id = p.arxiv_id
                             AND l.version = p.version
                             AND l.metadata_sha256 = p.metadata_sha256
                       )
                   )
                """
            ).fetchone()[0]
        )
        total_unhydrated = int(
            self.connection.execute(
                """
                SELECT COUNT(*) FROM discoveries d
                LEFT JOIN catalog_papers c ON c.arxiv_id = d.arxiv_id
                WHERE c.arxiv_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM paper_versions p WHERE p.arxiv_id = d.arxiv_id
                  )
                """
            ).fetchone()[0]
        )
        return {
            "schemaVersion": 1,
            "generatedAt": utc_now(),
            "candidateCount": total_review + total_unhydrated,
            "truncated": total_review + total_unhydrated > limit,
            "candidates": candidates,
            "metadataRequired": unhydrated,
        }

    def _sources_for(self, arxiv_id: str) -> list[dict[str, str]]:
        rows = self.connection.execute(
            """
            SELECT b.source, b.batch_key
            FROM discovery_sources ds
            JOIN listing_batches b ON b.batch_id = ds.batch_id
            WHERE ds.arxiv_id = ?
              AND b.batch_id = (
                  SELECT MAX(b2.batch_id)
                  FROM discovery_sources ds2
                  JOIN listing_batches b2 ON b2.batch_id = ds2.batch_id
                  WHERE ds2.arxiv_id = ds.arxiv_id AND b2.source = b.source
              )
            ORDER BY b.source
            LIMIT 16
            """,
            (arxiv_id,),
        ).fetchall()
        return [{"source": row["source"], "batchKey": row["batch_key"]} for row in rows]

    def complete_run(
        self,
        *,
        run_id: str,
        coverage_start: str,
        coverage_end: str,
        public_changes: int = 0,
        summary: Any | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any]:
        """Atomically promote staged cursors and complete a coverage run."""

        self._ensure_initialized()
        coverage_start = _iso_date(coverage_start, "coverage_start")
        coverage_end = _iso_date(coverage_end, "coverage_end")
        if coverage_start > coverage_end:
            raise ValueError("coverage_start must not be after coverage_end")
        if public_changes < 0:
            raise ValueError("public_changes cannot be negative")
        finished = completed_at or utc_now()
        with self.transaction() as db:
            run = self._require_running(db, run_id)
            if run["coverage_start"] is not None or run["coverage_end"] is not None:
                if (
                    run["coverage_start"] != coverage_start
                    or run["coverage_end"] != coverage_end
                ):
                    raise IncompleteRunError(
                        "completion coverage does not match the run plan: "
                        f"planned {run['coverage_start']}..{run['coverage_end']}, "
                        f"received {coverage_start}..{coverage_end}"
                    )
            required = {
                row["lane"]
                for row in db.execute(
                    "SELECT lane FROM run_required_lanes WHERE run_id = ?", (run_id,)
                )
            }
            lane_rows = {
                row["lane"]: row["status"]
                for row in db.execute(
                    "SELECT lane, status FROM run_lanes WHERE run_id = ?", (run_id,)
                )
            }
            incomplete = sorted(
                lane for lane in required if lane_rows.get(lane) not in SUCCESSFUL_LANE_STATES
            )
            unsuccessful = sorted(
                lane
                for lane, status in lane_rows.items()
                if status not in SUCCESSFUL_LANE_STATES
            )
            if incomplete or unsuccessful:
                pieces = []
                if incomplete:
                    pieces.append("incomplete required lanes: " + ", ".join(incomplete))
                if unsuccessful:
                    pieces.append("unsuccessful lanes: " + ", ".join(unsuccessful))
                raise IncompleteRunError("; ".join(pieces))
            pending_review = int(
                db.execute(
                    """
                    SELECT COUNT(*) FROM paper_versions
                    WHERE screening_status = 'pending'
                       OR reviewed_sha256 IS NULL
                       OR reviewed_sha256 <> metadata_sha256
                    """
                ).fetchone()[0]
            )
            unhydrated = int(
                db.execute(
                    """
                    SELECT COUNT(*) FROM discoveries d
                    LEFT JOIN catalog_papers c ON c.arxiv_id = d.arxiv_id
                    WHERE c.arxiv_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM paper_versions p WHERE p.arxiv_id = d.arxiv_id
                      )
                    """
                ).fetchone()[0]
            )
            accepted_unpublished = int(
                db.execute(
                    """
                    SELECT COUNT(*)
                    FROM paper_versions p
                    LEFT JOIN catalog_papers c ON c.arxiv_id = p.arxiv_id
                    WHERE p.screening_status = 'relevant'
                      AND p.reviewed_sha256 = p.metadata_sha256
                      AND (
                          c.arxiv_id IS NULL
                          OR c.arxiv_version IS NULL
                          OR c.arxiv_version < p.version
                      )
                    """
                ).fetchone()[0]
            )
            relevant_missing_references = int(
                db.execute(
                    """
                    SELECT COUNT(*)
                    FROM paper_versions p
                    LEFT JOIN catalog_papers c ON c.arxiv_id = p.arxiv_id
                    LEFT JOIN reference_heads h
                      ON h.arxiv_id = p.arxiv_id AND h.version = p.version
                    WHERE p.screening_status = 'relevant'
                      AND p.reviewed_sha256 = p.metadata_sha256
                      AND (
                          c.arxiv_id IS NULL
                          OR c.arxiv_version IS NULL
                          OR c.arxiv_version < p.version
                      )
                      AND h.snapshot_id IS NULL
                    """
                ).fetchone()[0]
            )
            mapped_missing_references = 0
            if "references" in required:
                mapped_missing_references = int(
                    db.execute(
                        """
                        SELECT COUNT(*)
                        FROM catalog_papers c
                        LEFT JOIN reference_heads h
                          ON h.arxiv_id = c.arxiv_id
                         AND h.version = c.arxiv_version
                        WHERE c.arxiv_version IS NULL
                           OR h.snapshot_id IS NULL
                        """
                    ).fetchone()[0]
                )
            ambiguous_unpublished = int(
                db.execute(
                    """
                    SELECT COUNT(*)
                    FROM paper_versions p
                    WHERE p.screening_status = 'ambiguous'
                      AND p.reviewed_sha256 = p.metadata_sha256
                      AND NOT EXISTS (
                          SELECT 1 FROM candidate_log_entries l
                          WHERE l.arxiv_id = p.arxiv_id
                            AND l.version = p.version
                            AND l.metadata_sha256 = p.metadata_sha256
                      )
                    """
                ).fetchone()[0]
            )
            if pending_review or unhydrated:
                raise IncompleteRunError(
                    "unresolved review work prevents coverage completion: "
                    f"{pending_review} pending/changed version(s), "
                    f"{unhydrated} unhydrated discovery ID(s)"
                )
            if relevant_missing_references:
                raise IncompleteRunError(
                    "accepted unpublished work lacks an exact-version complete "
                    f"reference snapshot: {relevant_missing_references} record(s)"
                )
            if mapped_missing_references:
                raise IncompleteRunError(
                    "mapped catalog lacks exact-version complete reference coverage: "
                    f"{mapped_missing_references} paper(s)"
                )
            if accepted_unpublished and public_changes == 0:
                raise IncompleteRunError(
                    "accepted but unpublished work prevents a no-change completion: "
                    f"{accepted_unpublished} relevant paper/version record(s); "
                    "publish them and complete with public_changes > 0"
                )
            if ambiguous_unpublished and public_changes == 0:
                raise IncompleteRunError(
                    "ambiguous but unpublished work prevents a no-change completion: "
                    f"{ambiguous_unpublished} candidate-log record(s); "
                    "publish them and complete with public_changes > 0"
                )
            staged = db.execute(
                "SELECT * FROM cursor_updates WHERE run_id = ?", (run_id,)
            ).fetchall()
            for row in staged:
                db.execute(
                    """
                    INSERT INTO cursors(
                        lane, cursor_key, value_json, promoted_by_run_id, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(lane, cursor_key) DO UPDATE SET
                        value_json = excluded.value_json,
                        promoted_by_run_id = excluded.promoted_by_run_id,
                        updated_at = excluded.updated_at
                    """,
                    (
                        row["lane"],
                        row["cursor_key"],
                        row["value_json"],
                        run_id,
                        finished,
                    ),
                )
            staged_authors = db.execute(
                "SELECT * FROM author_cursor_updates WHERE run_id = ?", (run_id,)
            ).fetchall()
            for row in staged_authors:
                db.execute(
                    """
                    INSERT INTO authors(
                        author_key, display_name, value_json,
                        promoted_by_run_id, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(author_key) DO UPDATE SET
                        display_name = excluded.display_name,
                        value_json = excluded.value_json,
                        promoted_by_run_id = excluded.promoted_by_run_id,
                        updated_at = excluded.updated_at
                    """,
                    (
                        row["author_key"],
                        row["display_name"],
                        row["value_json"],
                        run_id,
                        finished,
                    ),
                )
            db.execute(
                """
                UPDATE runs SET
                    status = 'completed', completed_at = ?, coverage_start = ?,
                    coverage_end = ?, public_changes = ?, summary_json = ?
                WHERE run_id = ?
                """,
                (
                    finished,
                    coverage_start,
                    coverage_end,
                    public_changes,
                    canonical_json(summary or {}),
                    run_id,
                ),
            )
            db.execute(
                """
                INSERT INTO metadata(key, value_json, updated_at)
                VALUES ('last_completed_coverage', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (
                    canonical_json(
                        {
                            "runId": run_id,
                            "coverageStart": coverage_start,
                            "coverageEnd": coverage_end,
                            "completedAt": finished,
                            "publicChanges": public_changes,
                        }
                    ),
                    finished,
                ),
            )
        return {
            "runId": run_id,
            "status": "completed",
            "coverageStart": coverage_start,
            "coverageEnd": coverage_end,
            "publicChanges": public_changes,
            "acceptedUnpublished": accepted_unpublished,
            "relevantMissingReferences": relevant_missing_references,
            "mappedMissingReferences": mapped_missing_references,
            "ambiguousUnpublished": ambiguous_unpublished,
            "promotedCursors": len(staged),
            "promotedAuthors": len(staged_authors),
        }

    def abort_run(self, run_id: str, summary: Any | None = None) -> dict[str, Any]:
        self._ensure_initialized()
        with self.transaction() as db:
            self._require_running(db, run_id)
            db.execute(
                """
                UPDATE runs SET status = 'failed', completed_at = ?, summary_json = ?
                WHERE run_id = ?
                """,
                (utc_now(), canonical_json(summary or {}), run_id),
            )
        return {"runId": run_id, "status": "failed", "cursorsPromoted": False}

    def plan(
        self,
        *,
        through: str | None = None,
        overlap_days: int = 2,
        author_limit: int = 8,
        candidate_limit: int = 200,
        today: dt.date | None = None,
    ) -> dict[str, Any]:
        """Create a deterministic next-run plan without changing state."""

        self._ensure_initialized()
        if overlap_days < 0 or author_limit < 0:
            raise ValueError("overlap_days and author_limit cannot be negative")
        end = (
            dt.date.fromisoformat(through)
            if through
            else latest_expected_announcement_date(today)
        )
        last = self.get_metadata("last_completed_coverage")
        baseline = self.get_metadata("catalog_last_successful_scan")
        if last and last.get("coverageEnd"):
            last_date = dt.date.fromisoformat(last["coverageEnd"])
        elif baseline:
            last_date = dt.date.fromisoformat(_date_part(str(baseline)))
        else:
            last_date = end
        start = min(end, last_date) - dt.timedelta(days=overlap_days)
        authors = self.connection.execute(
            """
            SELECT
                r.author_key,
                r.display_name,
                r.first_seen_at,
                r.source,
                a.updated_at,
                a.value_json
            FROM author_registry r
            LEFT JOIN authors a ON a.author_key = r.author_key
            ORDER BY a.updated_at IS NOT NULL, a.updated_at, r.author_key
            LIMIT ?
            """,
            (author_limit,),
        ).fetchall()
        bundle = self.review_bundle(limit=candidate_limit)
        return {
            "schemaVersion": 1,
            "generatedAt": utc_now(),
            "coverage": {"start": start.isoformat(), "end": end.isoformat()},
            "overlapDays": overlap_days,
            "lastCompletedCoverage": last,
            "pendingReviewCount": bundle["candidateCount"],
            "authorsDue": [
                {
                    "authorKey": row["author_key"],
                    "displayName": row["display_name"],
                    "firstSeenAt": row["first_seen_at"],
                    "source": row["source"],
                    "lastCompletedAt": row["updated_at"],
                    "cursor": (
                        json.loads(row["value_json"])
                        if row["value_json"] is not None
                        else None
                    ),
                }
                for row in authors
            ],
            "committedSearchCursors": {
                row["cursor_key"]: json.loads(row["value_json"])
                for row in self.connection.execute(
                    """
                    SELECT cursor_key, value_json FROM cursors
                    WHERE lane = 'search' ORDER BY cursor_key
                    """
                )
            },
        }

    def status(self) -> dict[str, Any]:
        self._ensure_initialized()
        counts = {}
        for table in (
            "catalog_papers",
            "candidate_log_entries",
            "runs",
            "listing_batches",
            "discoveries",
            "paper_versions",
            "screening_events",
            "reference_snapshots",
            "cursors",
            "authors",
            "author_registry",
        ):
            counts[table] = int(self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        latest = self.connection.execute(
            """
            SELECT run_id, kind, status, started_at, completed_at,
                   coverage_start, coverage_end, public_changes
            FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1
            """
        ).fetchone()
        return {
            "schemaVersion": SCHEMA_VERSION,
            "state": str(self.path),
            "counts": counts,
            "lastCompletedCoverage": self.get_metadata("last_completed_coverage"),
            "latestRun": dict(latest) if latest is not None else None,
            "pendingReviewCount": self.review_bundle(limit=1)["candidateCount"],
        }

    def checkpoint(self) -> None:
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    @classmethod
    def rebuild(
        cls,
        state_path: str | os.PathLike[str],
        *,
        landscape_path: str | os.PathLike[str] | None = None,
        candidates_path: str | os.PathLike[str] | None = None,
    ) -> dict[str, Any]:
        """Build a fresh database, archive the old exact files, then swap atomically."""

        target = Path(state_path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.rebuild-{uuid.uuid4().hex}.tmp")
        with cls(temporary) as fresh:
            fresh.initialize()
            bootstrap = (
                fresh.bootstrap_landscape(landscape_path)
                if landscape_path is not None
                else {"catalogPapers": 0}
            )
            if candidates_path is not None:
                bootstrap.update(fresh.bootstrap_candidate_log(candidates_path))
            fresh.checkpoint()
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = target.with_name(f"{target.name}.backup-{stamp}")
        suffix = 1
        while backup.exists():
            backup = target.with_name(f"{target.name}.backup-{stamp}-{suffix}")
            suffix += 1
        moved: list[tuple[Path, Path]] = []
        try:
            if target.exists():
                with cls(target) as old:
                    old.checkpoint()
                for ending in ("", "-wal", "-shm"):
                    source = Path(str(target) + ending)
                    if source.exists():
                        destination = Path(str(backup) + ending)
                        os.replace(source, destination)
                        moved.append((source, destination))
            os.replace(temporary, target)
            for ending in ("-wal", "-shm"):
                temp_sidecar = Path(str(temporary) + ending)
                if temp_sidecar.exists():
                    os.replace(temp_sidecar, Path(str(target) + ending))
        except Exception:
            if not target.exists() and moved:
                for source, destination in reversed(moved):
                    if destination.exists():
                        os.replace(destination, source)
            raise
        return {
            "state": str(target),
            "backup": str(backup) if moved else None,
            **bootstrap,
        }
