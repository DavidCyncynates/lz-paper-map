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
update. Committed coordinates remain fixed semantic anchors. The browser first
settles each primary island independently: dots and its label repel at short
range while weak attraction makes the group compact. An exact padded minimum
circle encloses that complete group. Those rigid circles are then packed by a
second deterministic attraction-and-repulsion pass, with the unshaded LZ result
participating as its own collision body. Later-added papers absorb most new
local collision adjustment, limiting disruption to established groups. Each
record has an immutable layout rank assigned when it enters the catalog, so a
late-discovered older preprint is still treated as the newcomer and a later JSON
reorder cannot change the map. The canvas can be scrolled, dragged, and zoomed
without changing the underlying semantic layout; if measured geometry cannot be
packed safely, the map stays hidden and the matching list view remains
available.

The full rationale, data contract, trust boundaries, stable-layout policy, and
failure behavior are in [docs/architecture.md](docs/architecture.md).

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
pnpm typecheck
pnpm lint
pnpm test:layout
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

The task is instructed to use a dedicated worktree and public arXiv listing,
abstract, HTML, and PDF pages. Its discovery pass enumerates the relevant
listings, reads plausible abstracts even when their titles do not name LZ, and
adds broad phrase, citation-neighbor, and author searches. It checks for new
papers and revisions, verifies outgoing citations from reference lists, and
derives “cited by” relationships from those verified outgoing citations. On
Sundays it reconciles the full mapped citation graph, which also repairs older
omissions. It never calls the OpenAI developer API or arXiv Atom API, and an
incomplete discovery lane cannot advance the successful-scan timestamp.

The task never publishes directly. A substantive change is proposed on a
`codex/arxiv-daily-*` branch and pull request for human review; a no-change run
does nothing. If an earlier maintenance pull request is still open, the next run
pauses instead of competing with it. The first few runs should be reviewed
closely before considering any more permissive publication policy.

The local task needs unattended access to public arXiv pages and to this GitHub
repository. Before the first run, verify those permissions and an authenticated
GitHub CLI session, then test one run manually. Without them, research or pull
request creation will stop safely and require attention.

## Editing the atlas

The public catalog is [data/landscape.json](data/landscape.json). Island IDs are
stable editorial concepts. To make a manual correction, edit the record, run
the validation command, and commit the change. Add new records at the end with
the next unused `layoutRank`; never change an established record's rank. The
legacy update script remains available as a validator, but its network/API
update mode is disabled; the scheduled task runs it only with `--validate-only`.

Successful scans that change data add an audit record under `data/runs/`.
Uncertain candidates that need human judgment are retained in
`data/candidates.json`.

Thank you to arXiv for its public open-access literature pages.
