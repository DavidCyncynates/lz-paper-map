"""Command-line interface for the incremental maintenance ledger."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

from .ledger import (
    DEFAULT_REQUIRED_LANES,
    Ledger,
    LedgerError,
    canonical_arxiv_ids,
    default_state_path,
)


def _json_value(raw: str | None, path: str | None) -> Any:
    if raw is not None and path is not None:
        raise ValueError("provide either --value or --value-file, not both")
    if path is not None:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    if raw is None:
        raise ValueError("one of --value or --value-file is required")
    return json.loads(raw)


def _json_file(path: str | None, default: Any = None) -> Any:
    return default if path is None else json.loads(Path(path).read_text(encoding="utf-8"))


def _ids(arguments: argparse.Namespace) -> list[str]:
    values = list(arguments.id or [])
    if arguments.ids_file:
        text = Path(arguments.ids_file).read_text(encoding="utf-8")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = [line.strip() for line in text.splitlines() if line.strip()]
        if isinstance(parsed, dict):
            parsed = parsed.get("ids")
        if not isinstance(parsed, list):
            raise ValueError("IDs file must be a JSON array, {\"ids\": [...]}, or one ID per line")
        values.extend(str(item) for item in parsed)
    return canonical_arxiv_ids(values)


def _write_json(value: Any, *, output: str | None, pretty: bool) -> None:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    if output:
        target = Path(output)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.tmp")
        temporary.write_text(serialized + "\n", encoding="utf-8")
        temporary.replace(target)
    else:
        print(serialized)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m scripts.maintenance",
        description="Durable incremental maintenance state for the LZ paper map.",
    )
    parser.add_argument(
        "--state",
        default=str(default_state_path()),
        help="SQLite state path (default: LZ_MAINTENANCE_STATE or stable task-local state)",
    )
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON output")
    commands = parser.add_subparsers(dest="command", required=True)

    initialize = commands.add_parser("initialize", help="initialize and bootstrap the ledger")
    initialize.add_argument("--landscape", default="data/landscape.json")
    initialize.add_argument("--candidates", default="data/candidates.json")

    plan = commands.add_parser("plan", help="show the next incremental coverage plan")
    plan.add_argument("--through", help="inclusive end date (YYYY-MM-DD; defaults to today)")
    plan.add_argument("--overlap-days", type=int, default=2)
    plan.add_argument("--author-limit", type=int, default=8)
    plan.add_argument("--candidate-limit", type=int, default=200)

    start = commands.add_parser("start-run", help="start an atomic coverage run")
    start.add_argument("--kind", default="daily")
    start.add_argument("--base-commit")
    start.add_argument("--started-at")
    start.add_argument("--coverage-start")
    start.add_argument("--coverage-end")
    start.add_argument("--run-id")
    start.add_argument(
        "--required-lane",
        action="append",
        help="required coverage lane; repeat as needed (defaults to all daily lanes)",
    )

    lane = commands.add_parser("set-lane", help="record one run lane's outcome")
    lane.add_argument("--run-id", required=True)
    lane.add_argument("--lane", required=True)
    lane.add_argument(
        "--status", required=True, choices=("completed", "no_change", "deferred", "failed")
    )
    lane.add_argument("--detail-file")

    listing = commands.add_parser("record-listing", help="record an immutable listing snapshot")
    listing.add_argument("--run-id", required=True)
    listing.add_argument("--source", required=True)
    listing.add_argument("--batch-key", required=True)
    listing.add_argument("--retrieved-at")
    listing.add_argument("--id", action="append")
    listing.add_argument("--ids-file")
    listing.add_argument("--payload-file", help="raw page used to calculate the content hash")
    listing.add_argument(
        "--coverage-only",
        action="store_true",
        help="retain IDs as coverage evidence without adding them to the review queue",
    )

    observe = commands.add_parser("observe-paper", help="record current metadata for a paper version")
    observe.add_argument("--run-id", required=True)
    observe.add_argument("--arxiv-id", required=True)
    observe.add_argument("--version", required=True, type=int)
    observe.add_argument("--metadata-file", required=True)

    screen = commands.add_parser("screen", help="record a paper-version screening decision")
    screen.add_argument("--run-id", required=True)
    screen.add_argument("--arxiv-id", required=True)
    screen.add_argument("--version", required=True, type=int)
    screen.add_argument("--decision", required=True, choices=("relevant", "excluded", "ambiguous"))
    screen.add_argument("--reason")

    references = commands.add_parser(
        "record-references", help="store a complete immutable reference snapshot"
    )
    references.add_argument("--run-id", required=True)
    references.add_argument("--arxiv-id", required=True)
    references.add_argument("--version", required=True, type=int)
    references.add_argument("--id", action="append")
    references.add_argument("--ids-file")
    references.add_argument("--source-url")
    references.add_argument("--retrieved-at")
    references.add_argument("--supersede", action="store_true")

    search_cursor = commands.add_parser(
        "set-search-cursor", help="stage a search cursor for promotion on run completion"
    )
    search_cursor.add_argument("--run-id", required=True)
    search_cursor.add_argument("--name", required=True)
    search_cursor.add_argument("--value")
    search_cursor.add_argument("--value-file")

    author_cursor = commands.add_parser(
        "set-author-cursor", help="stage a unique-author cursor for promotion on completion"
    )
    author_cursor.add_argument("--run-id", required=True)
    author_cursor.add_argument("--author", required=True)
    author_cursor.add_argument("--value")
    author_cursor.add_argument("--value-file")

    get_cursor = commands.add_parser("get-cursor", help="read a committed cursor")
    get_cursor.add_argument("--lane", required=True)
    get_cursor.add_argument("--key", required=True)

    bundle = commands.add_parser(
        "review-bundle", help="emit only unseen or changed review candidates"
    )
    bundle.add_argument("--limit", type=int, default=200)
    bundle.add_argument("--output")

    citations = commands.add_parser(
        "mapped-citations",
        help="derive mapped outgoing and cited-by edges from complete reference snapshots",
    )
    citations.add_argument("--landscape", default="data/landscape.json")
    citations.add_argument(
        "--include-id",
        action="append",
        help="additional relevant/new arXiv ID to include in the intersection",
    )
    citations.add_argument("--output")

    complete = commands.add_parser(
        "complete-run", help="atomically complete coverage and promote staged cursors"
    )
    complete.add_argument("--run-id", required=True)
    complete.add_argument("--coverage-start", required=True)
    complete.add_argument("--coverage-end", required=True)
    complete.add_argument("--public-changes", type=int, default=0)
    complete.add_argument("--summary-file")
    complete.add_argument("--completed-at")

    abort = commands.add_parser("abort-run", help="fail a run without promoting cursors")
    abort.add_argument("--run-id", required=True)
    abort.add_argument("--summary-file")

    commands.add_parser("status", help="show a compact ledger status report")

    rebuild = commands.add_parser(
        "rebuild", help="atomically rebuild from the catalog and archive the old database"
    )
    rebuild.add_argument("--landscape", default="data/landscape.json")
    rebuild.add_argument("--candidates", default="data/candidates.json")
    rebuild.add_argument(
        "--confirm",
        required=True,
        help="must exactly equal the resolved --state path",
    )

    reset = commands.add_parser(
        "reset", help="archive the exact database and create a fresh empty ledger"
    )
    reset.add_argument(
        "--confirm",
        required=True,
        help="must exactly equal the resolved --state path",
    )
    return parser


def _run(arguments: argparse.Namespace) -> tuple[Any, str | None]:
    state = Path(arguments.state).expanduser().resolve()
    if arguments.command in ("rebuild", "reset"):
        if arguments.confirm != str(state):
            raise ValueError("--confirm must exactly equal the resolved --state path")
        result = Ledger.rebuild(
            state,
            landscape_path=arguments.landscape if arguments.command == "rebuild" else None,
            candidates_path=arguments.candidates if arguments.command == "rebuild" else None,
        )
        return result, None

    with Ledger(state) as ledger:
        if arguments.command == "initialize":
            ledger.initialize()
            result = ledger.bootstrap_landscape(arguments.landscape)
            result.update(ledger.bootstrap_candidate_log(arguments.candidates))
            return result, None
        ledger._ensure_initialized()
        if arguments.command == "plan":
            return (
                ledger.plan(
                    through=arguments.through,
                    overlap_days=arguments.overlap_days,
                    author_limit=arguments.author_limit,
                    candidate_limit=arguments.candidate_limit,
                ),
                None,
            )
        if arguments.command == "start-run":
            lanes = arguments.required_lane or list(DEFAULT_REQUIRED_LANES)
            return (
                ledger.start_run(
                    kind=arguments.kind,
                    base_commit=arguments.base_commit,
                    started_at=arguments.started_at,
                    coverage_start=arguments.coverage_start,
                    coverage_end=arguments.coverage_end,
                    required_lanes=lanes,
                    run_id=arguments.run_id,
                ),
                None,
            )
        if arguments.command == "set-lane":
            ledger.set_lane(
                arguments.run_id,
                arguments.lane,
                arguments.status,
                _json_file(arguments.detail_file, {}),
            )
            return {"runId": arguments.run_id, "lane": arguments.lane, "status": arguments.status}, None
        if arguments.command == "record-listing":
            payload = Path(arguments.payload_file).read_bytes() if arguments.payload_file else None
            return (
                ledger.record_listing_batch(
                    run_id=arguments.run_id,
                    source=arguments.source,
                    batch_key=arguments.batch_key,
                    ids=_ids(arguments),
                    retrieved_at=arguments.retrieved_at,
                    payload=payload,
                    discover=not arguments.coverage_only,
                ),
                None,
            )
        if arguments.command == "observe-paper":
            metadata = _json_file(arguments.metadata_file)
            if not isinstance(metadata, dict):
                raise ValueError("metadata file must contain one JSON object")
            return (
                ledger.observe_paper(
                    run_id=arguments.run_id,
                    arxiv_id=arguments.arxiv_id,
                    version=arguments.version,
                    metadata=metadata,
                ),
                None,
            )
        if arguments.command == "screen":
            return (
                ledger.screen_paper(
                    run_id=arguments.run_id,
                    arxiv_id=arguments.arxiv_id,
                    version=arguments.version,
                    decision=arguments.decision,
                    reason=arguments.reason,
                ),
                None,
            )
        if arguments.command == "record-references":
            return (
                ledger.record_reference_snapshot(
                    run_id=arguments.run_id,
                    arxiv_id=arguments.arxiv_id,
                    version=arguments.version,
                    references=_ids(arguments),
                    source_url=arguments.source_url,
                    retrieved_at=arguments.retrieved_at,
                    supersede=arguments.supersede,
                ),
                None,
            )
        if arguments.command == "set-search-cursor":
            return (
                ledger.stage_cursor(
                    run_id=arguments.run_id,
                    lane="search",
                    key=arguments.name,
                    value=_json_value(arguments.value, arguments.value_file),
                ),
                None,
            )
        if arguments.command == "set-author-cursor":
            return (
                ledger.stage_author_cursor(
                    run_id=arguments.run_id,
                    author=arguments.author,
                    value=_json_value(arguments.value, arguments.value_file),
                ),
                None,
            )
        if arguments.command == "get-cursor":
            return {
                "lane": arguments.lane,
                "key": arguments.key,
                "value": ledger.get_cursor(arguments.lane, arguments.key),
            }, None
        if arguments.command == "review-bundle":
            return ledger.review_bundle(arguments.limit), arguments.output
        if arguments.command == "mapped-citations":
            landscape = _json_file(arguments.landscape)
            papers = landscape.get("papers") if isinstance(landscape, dict) else None
            if not isinstance(papers, list):
                raise ValueError("landscape JSON does not contain a papers array")
            identifiers = [str(paper.get("arxivId") or paper["id"]) for paper in papers]
            identifiers.extend(arguments.include_id or [])
            return ledger.mapped_citations(identifiers), arguments.output
        if arguments.command == "complete-run":
            return (
                ledger.complete_run(
                    run_id=arguments.run_id,
                    coverage_start=arguments.coverage_start,
                    coverage_end=arguments.coverage_end,
                    public_changes=arguments.public_changes,
                    summary=_json_file(arguments.summary_file, {}),
                    completed_at=arguments.completed_at,
                ),
                None,
            )
        if arguments.command == "abort-run":
            return (
                ledger.abort_run(arguments.run_id, _json_file(arguments.summary_file, {})),
                None,
            )
        if arguments.command == "status":
            return ledger.status(), None
    raise AssertionError(f"unhandled command: {arguments.command}")


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(list(argv) if argv is not None else None)
    try:
        result, output = _run(arguments)
        _write_json(result, output=output, pretty=arguments.pretty)
        return 0
    except (LedgerError, ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
