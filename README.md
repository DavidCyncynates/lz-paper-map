# LZ Paper Map

An island-like literature map for papers responding to the LUX-ZEPLIN high-
recoil candidate announced on 1 September 2026.

**Live site:** [davidcyncynates.github.io/lz-paper-map](https://davidcyncynates.github.io/lz-paper-map/)

The atlas contains the LZ experimental paper and the response literature found
through the latest reviewed arXiv scan. Nearby dots share mechanisms or
phenomenology; the islands name the main families of ideas. Search, filters,
publication-date windows, map/list views, hover explanations for each island,
optional citation-scaled dots, paper details, and shareable links are built in.
The color theme follows the visitor's system on first load; the top-bar switch
stores an explicit light or dark preference only in that browser and shares it
with the main personal site on the same origin.

This is a literature-navigation aid, not a statement of scientific consensus.
The LZ result is one roughly 248 keV candidate with 2.6σ global significance,
not a discovery. Placement and summaries are machine-assisted; metadata and
outgoing paper links come from arXiv.

## Architecture

The site is a static export hosted by GitHub Pages. A local Codex scheduled task
reviews arXiv's public web pages after each announcement, validates any proposed
catalog changes, and opens a pull request. It uses the signed-in Codex account,
not an OpenAI developer API key or the arXiv API. A human merge publishes the
update.

The maintenance workflow is incremental. A task-local SQLite ledger remembers
completed announcement batches, arXiv versions, screening decisions, search and
author cursors, and complete reference snapshots. Unchanged paper versions are
not reviewed again, and no-change days advance the private coverage cursor
without creating noisy website commits. The ledger is a disposable cache rather
than an editorial authority: public changes still require fresh source evidence,
validation, and review.

Map geometry and catalog indexes are deterministic generated artifacts. Both
uniform and citation-sized layouts are computed before publication. A
prefix-stable golden-angle packer makes each island compact, spatially indexed
collision checks enforce clearance, and a deterministic incremental enclosing
circle wraps the result. The browser swaps stored coordinates instead of
running a force solver. Committed semantic coordinates and immutable layout
ranks remain the stable inputs, so later additions absorb most local movement.
The independent camera fits, scrolls, drags, wheel-zooms, and supports native
one-finger pan and two-finger pinch gestures without changing the layout.

The full rationale, data contract, trust boundaries, stable-layout policy, and
failure behavior are in [docs/architecture.md](docs/architecture.md). The
step-by-step task contract is in
[docs/maintenance-runbook.md](docs/maintenance-runbook.md).

## Run locally

Requirements: Node.js 22.13 or newer, pnpm 11.19, and Python 3.12.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

Useful checks:

```bash
python3 scripts/update_papers.py --validate-only
python3 -m scripts.maintenance --help
pnpm generate:artifacts
pnpm check:generated
pnpm test:maintenance
pnpm test:catalog-index
pnpm typecheck
pnpm lint
pnpm test:layout
pnpm test:layout-artifact
pnpm test:map-camera
pnpm test:date-range
pnpm test:citation-size
pnpm test:theme
pnpm build
```

The static site is written to `dist/client`.

## Deployment and scheduled maintenance

Pushes to `main` are validated and published automatically at the live address
above. The Pages workflow also supports forks published either as project sites
or root user/organization Pages sites.

The literature review runs as a standalone Codex desktop task every day at
11:00 in `Europe/Rome`. This leaves a generous buffer after arXiv's nominal
20:00 US Eastern announcement, including during the brief periods when European
and US daylight-saving transitions do not align. The computer must be awake and
the Codex app must be running.

The task uses a dedicated worktree and a durable local maintenance ledger. A
rate-limited collector reads public arXiv listing, search, abstract, HTML, and
PDF pages and emits a compact bundle of only unseen or revised candidates. The
model reviews that bundle, not the full catalog or raw result pages. Discovery
uses a newest-first INSPIRE citation-neighbor web check, broad arXiv
abstract/metadata phrases, exact observation identifiers and titles,
replacement listings, and a rotating unique-author lane, so relevant papers do
not need to name LZ in their titles. INSPIRE supplies candidate IDs only;
official metadata and inclusion evidence still come from arXiv.

Complete outgoing arXiv references are cached by paper version. Mapped `cites`
and reverse “cited by” relationships are then derived locally, so an unchanged
bibliography is never fetched merely because the map grew. Revisions are caught
by the bounded overlap of new/recent category listings and by incremental broad
and rotating author searches; known IDs surfaced there are checked for a newer
exact arXiv version. It never calls the OpenAI developer API or arXiv Atom API,
and an incomplete required lane cannot advance the private maintenance cursor
or public scan timestamp.

The task never publishes directly. A substantive change is proposed on a
`codex/arxiv-daily-*` branch and pull request for human review; a no-change run
does nothing. If an earlier maintenance pull request is still open, the next run
pauses instead of competing with it. The first few runs should be reviewed
closely before considering any more permissive publication policy.

The category system is human-owned. Every daily run must read
[`docs/taxonomy.md`](docs/taxonomy.md) before screening candidates and use only
the fixed categories and decision rules defined there. It may classify a new
paper within that taxonomy, but it must never create, rename, split, merge, or
delete a category. Ambiguous assignments are queued for human review rather
than resolved by changing the map's vocabulary.

The local task needs unattended access to public arXiv pages and to this GitHub
repository. Before the first run, verify those permissions and an authenticated
GitHub CLI session, then test one run manually. Without them, research or pull
request creation will stop safely and require attention.

## Editing the atlas

The public catalog is [data/landscape.json](data/landscape.json). Island IDs are
stable editorial concepts governed by
[`docs/taxonomy.md`](docs/taxonomy.md). To make a manual correction, edit the
record, run the validation command, and commit the change. Every record must pin
the exact positive `arxivVersion` used for its metadata and reference snapshot.
Add new records at the end with the next unused `layoutRank`; never change an
established record's rank. The legacy update script remains available as a
validator, but its network/API update mode is disabled; the scheduled task runs
it only with `--validate-only`.

Successful scans that change data add an audit record under `data/runs/`.
Uncertain candidates that need human judgment are retained in
`data/candidates.json`, keyed by canonical arXiv ID, exact version, and metadata
digest. Generated files under `data/generated/` must be refreshed with
`pnpm generate:artifacts` whenever the catalog changes; CI rejects stale indexes
or layouts.

Thank you to arXiv for its public open-access literature pages.
