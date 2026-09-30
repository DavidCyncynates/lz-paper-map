# Incremental maintenance ledger

This directory contains the durable state layer for the LZ paper-map updater.
The public `data/landscape.json` file remains the website's source of truth;
the SQLite ledger is a rebuildable private cache that prevents every daily run
from repeating the full literature scan.

The implementation uses only the Python standard library. Run it from the
repository root with:

```sh
python3 -m scripts.maintenance --pretty initialize --landscape data/landscape.json
python3 -m scripts.maintenance --pretty plan --through 2026-10-01
```

Every public catalog paper must carry its exact positive `arxivVersion`.
Dates are never used to guess version identity: a same-day revision is still a
new review unit. `initialize` also imports `data/candidates.json`; every entry
there must have `status: "ambiguous"`, an exact `arxivId` and positive
`version`, and the reviewed metadata's lowercase `metadataSha256` digest.

By default, state lives at:

```text
~/.codex/automations/refresh-lz-paper-map/state/maintenance.sqlite3
```

Set `LZ_MAINTENANCE_STATE` or pass `--state /absolute/path.sqlite3` to use a
different location. The default deliberately sits outside ephemeral Git
worktrees.

## Run lifecycle

1. `start-run` creates a run and reports its `runId`. Pass both
   `--coverage-start` and `--coverage-end` to bind the planned interval to the
   run; use the exact interval returned by `plan`. The harvester rejects a
   bound interval that differs from the durable next plan, and completion must
   use that same interval. Only one run may remain active: recover an
   interrupted run explicitly with `abort-run` before starting a forced or
   scheduled replacement. Catalog and candidate-log
   bootstraps are likewise refused while a run is active, so a baseline cannot
   change under an in-flight scan.
2. `record-listing` stores immutable listing/search evidence and versionless
   arXiv IDs. A changed source page becomes a new immutable snapshot. Use
   `--coverage-only` for broad category pages whose complete ID set proves scan
   coverage but should not enter the candidate queue.
3. `observe-paper` stores metadata for an exact arXiv version.
4. `review-bundle` emits only new papers, new versions, metadata changes, and
   discovered IDs whose metadata still needs fetching.
5. `screen` records an immutable review event.
6. `record-references` stores every explicit arXiv ID in a complete bibliography.
   A corrected extraction requires `--supersede`; the older snapshot is kept.
7. `mapped-citations` intersects the latest complete snapshots with the public
   catalog (plus any repeated `--include-id`). It emits deterministic outgoing,
   cited-by, and citation-count indexes without revisiting the source pages.
8. `set-search-cursor` and `set-author-cursor` stage frontiers. They are not
   visible as committed cursors until the run succeeds.
9. Mark each required lane with `set-lane`, then use `complete-run`. Completion
   promotes every staged cursor in the same transaction and records coverage
   even when `--public-changes 0`.

Revision detection is not a standalone lane. The harvester hydrates known IDs
that resurface in bounded overlapping new/recent listings or above targeted and
rotating author-search frontiers, then compares their exact observed versions.
Successful harvests mark the listing, search, and author lanes that provide this
revision coverage.

Example no-change completion:

```sh
STATE="$HOME/.codex/automations/refresh-lz-paper-map/state/maintenance.sqlite3"
RUN_ID="$(python3 -m scripts.maintenance --state "$STATE" start-run | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')"

for lane in listings searches citation_discovery authors references; do
  python3 -m scripts.maintenance --state "$STATE" set-lane \
    --run-id "$RUN_ID" --lane "$lane" --status no_change
done

python3 -m scripts.maintenance --state "$STATE" complete-run \
  --run-id "$RUN_ID" \
  --coverage-start 2026-09-29 \
  --coverage-end 2026-10-01 \
  --public-changes 0
```

If a required lane is missing, deferred, or failed, completion stops without
promoting any cursors. Completion also stops while a discovered ID lacks
metadata or any paper version remains pending or changed. `abort-run` records
the failed attempt while preserving its evidence. Authors enter the rotating
author-search registry only after a paper is accepted as relevant.

Accepted papers and revisions remain in `review-bundle` with a `relevant`
screening status and an `accepted_unpublished` or
`accepted_revision_unpublished` reason until a later `initialize` against
merged main finds the same or newer catalog record. A no-change completion is
rejected while such work exists; the publishing run completes with
`--public-changes` greater than zero. Before that publishing run may complete,
each accepted exact version must also have a complete reference snapshot.

Ambiguous decisions remain in the bundle as `ambiguous_unpublished` until a
later `initialize` finds their exact identity and metadata digest in the merged
candidate log. They also reject a no-change completion, so an interrupted
candidate-log edit cannot be lost when cursors advance.

Citation output is deliberately fail-closed: `coverageComplete` remains false
and `missingSnapshotIds` names every mapped paper without a complete stored
bibliography. `staleSnapshotIds` identifies papers whose newest observed version
is newer than their stored bibliography. An explicit empty snapshot distinguishes
a paper with no arXiv references from a paper that has not been checked.

The cached HTML bibliography collector resolves exactly those missing and stale
mapped papers, plus any repeated `--id`, and records the whole bounded batch into
an active run:

```sh
python3 -m scripts.maintenance.references \
  --state "$STATE" --run-id "$RUN_ID" \
  --landscape data/landscape.json \
  --cache-dir "$HOME/.codex/automations/refresh-lz-paper-map/cache/arxiv-html" \
  --output /tmp/reference-snapshots.json
```

It reads only public arXiv `/html/` pages, identifies the exact paper version
from the document watermark or canonical metadata, and extracts IDs only from a
recognized bibliography container. The collector fetches and validates every
target before writing any snapshot, and marks the `references` lane only after
the full batch succeeds. A missing container, unknown version, or changed page
shape therefore fails closed. Standalone use omits `--state` and `--run-id` and
requires one or more explicit `--id`/`--ids-file` values.

Some papers do not have an arXiv HTML conversion. For those only, inspect the
versioned official PDF and provide a durable manual snapshot with the exact
version and an explicit completeness attestation:

```json
{
  "snapshots": [{
    "arxivId": "2609.20001",
    "version": 2,
    "complete": true,
    "references": ["2609.02823", "hep-ph/9901234"],
    "sourceUrl": "https://arxiv.org/pdf/2609.20001v2"
  }]
}
```

Pass that file with `--manual-snapshots-file`. Its IDs join the same bounded,
atomic batch as HTML-derived snapshots. The collector rejects versionless or
non-arXiv evidence URLs, conflicting identities, and any record that does not
literally set `complete` to `true`.

## Safe recovery

`rebuild` creates and verifies a new database before replacing the live one.
`reset` does the same with an empty database. Both archive the exact old
database and require the resolved state path as an explicit confirmation:

```sh
python3 -m scripts.maintenance --state "$STATE" rebuild \
  --landscape data/landscape.json \
  --confirm "$STATE"
```

No broad or recursive deletion is used. Because the ledger is a cache, it can
always be reconstructed from the public catalog and a bounded source backfill.

## Tests

```sh
python3 -m unittest discover -s scripts/tests/maintenance -p 'test_*.py' -v
```
