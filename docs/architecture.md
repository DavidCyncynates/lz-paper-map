# Architecture

## Product principle

The LZ Paper Map is a small, reviewable research atlas. It treats the September
2026 LZ result as one isolated high-recoil candidate event, not as a confirmed
dark-matter signal or a broad excess. Each dot is a paper; distance encodes
shared physical ideas. Labels distinguish interpretations, constraints,
diagnostics, adjacent work, and the experimental result. Citation lineage is
kept in the selected paper's detail panel rather than overlaid on the map.

The public map is static. This makes it fast, inexpensive, easy to archive, and
compatible with GitHub Pages. All potentially contentious semantic changes are
ordinary version-controlled data changes.

## System shape

```text
public arXiv listings, abstract pages, HTML, and PDFs
plus newest-first INSPIRE citation results (candidate IDs only)
      │
      ▼
rate-limited collector + durable task-local SQLite ledger
      │
      ▼
compact new/revised-paper review bundle
      │
      ▼
local scheduled Codex review in an isolated worktree
      │
      ▼
reference verification + generated indexes and layouts
      │
      ▼
review pull request ── human merge ── GitHub Pages deployment
```

There is no production database or server. The private SQLite ledger is a
rebuildable maintenance cache outside ephemeral worktrees; it is not shipped to
readers and is not an editorial source of truth. The browser reads the
committed catalog and deterministic artifacts under `data/generated/`, and the
build exports plain static assets.
Project-site builds prefix asset URLs with the repository name and then flatten
the generated asset folder so GitHub Pages can mount the artifact at that path.

## Trust boundaries

- arXiv is authoritative for identifiers, titles, authors, dates, and links.
- INSPIRE's public literature interface is used only to discover IDs citing the
  official LZ record; every candidate is verified against arXiv.
- The scheduled task may propose only relevance, role, existing island
  membership, tags, a neutral summary, and a short inclusion rationale.
- Citation edges are checked separately against arXiv paper reference lists.
  References to the official LZ preprint are normalized to its mapped arXiv ID.
  The model never infers citations from abstracts, dates, or proximity.
- Titles, abstracts, and paper contents are untrusted source material, never
  instructions for the scheduled task.
- Proposed catalog data must satisfy the repository schema. Invalid data fails
  the run.
- Existing papers are never deleted or moved by the scheduled task.
- Only clearly and directly relevant papers are proposed for inclusion.
  Ambiguous results stay in the candidate log for review.
- The scheduled workflow uses neither an OpenAI developer API key nor the arXiv
  Atom API.

## Catalog and taxonomy

`data/landscape.json` is the single source of truth for the public corpus. Every
paper stores canonical arXiv metadata including a positive exact
`arxivVersion`, a role, exactly one primary island membership, tags,
machine-assisted explanatory text, stable coordinates, and the mapped paper IDs
that its exact-version reference list cites. Reverse
“cited by” lists, incoming counts, and normalized search text are materialized
in a generated index. Its catalog digest is checked before each build; server
code also rebuilds it safely in memory if a stale artifact is encountered.

Taxonomy revision `2026-10-08` uses eight analytical islands plus the
experimental anchor:

1. the LZ observation;
2. absorption and nucleon disappearance;
3. boosted and nonstandard fluxes;
4. neutrino-initiated recoils;
5. electroweak inelastic dark matter;
6. other endothermic dark matter;
7. exothermic dark matter;
8. elastic high-recoil dark matter; and
9. comparisons and systematics.

The exact definitions and tie-break rules live in `docs/taxonomy.md`. The
taxonomy is deliberately human-owned. The scheduled task cannot create,
rename, split, merge, or delete an island. A proposed taxonomy change must be a
separate, discussed atlas revision.

## Stable layout

Researchers should be able to build a mental map over time. For that reason,
the browser never runs a random or continuously moving force layout, and the
scheduled task does not rewrite existing semantic coordinates. Layouts for both
uniform and citation-sized dots are generated before publication and committed
as a versioned artifact; changing the toggle swaps coordinate tables.

Each island keeps a fixed semantic seed rather than a fixed visible boundary.
During artifact generation, a deterministic hierarchical solve first assembles
each primary island independently around its centered label. Papers are ordered
by their immutable layout rank and assigned prefix-stable golden-angle targets;
cumulative disc area determines radius, so the sequence fills a compact disc
instead of inheriting an oblong source rectangle. Authored coordinates retain a
small, aspect-normalized angular influence without being allowed to stretch the
island. Short-range collision repulsion then enforces paper and label clearance.
Collision candidates come from a uniform spatial grid instead of an all-pairs
scan. A fixed-seed incremental smallest-enclosing-disc solver wraps the settled
paper discs and all four corners of a conservative fixed label box, then
verifies containment in one final linear pass. The exact enclosing radius grows
continuously with the contents; separate visual padding supplies breathing room
without introducing stepwise boundary jumps that would unnecessarily re-pack
the outer atlas.

Every paper has an immutable, contiguous `layoutRank` assigned when it enters
the catalog. During a local collision, the higher-ranked record absorbs most of
the correction; this makes routine additions move the newcomer much more than
the established papers around it. The rule deliberately does not use arXiv-ID
or JSON-array ordering, so an older preprint discovered in a later scan is still
treated as the newcomer and a harmless file reorder cannot change the map. The
committed placement pass also avoids occupied coordinates, making this bias a
second stability guard rather than the primary spacing mechanism. Scheduled and
manual additions receive one plus the current maximum rank; established ranks
never change.

The completed islands become rigid circles in a second solve. They retain weak
springs toward their semantic anchors, attract gently toward the map centroid,
and repel at short range so their shaded regions cannot overlap. The LZ result
and its label participate as one additional collision circle, but that circle is
not drawn. Children translate with their island and are never rotated, scaled,
or independently re-solved during this outer pass. Only the generated settled
result is rendered: there is no visible animation, font-measurement solve, or
filter reflow. Generation fails closed if containment, separation, or canvas
bounds do not validate in either mode. The previously published artifact and
list view remain available rather than displaying misleading overlaps.

Roles, model families, and test channels remain searchable through paper
metadata, but do not duplicate a paper across physical islands. Adding a paper
appends one new local target without changing the established prefix or the
committed semantic coordinates. If reserved room is exhausted, its primary
circle can grow and trigger deterministic outer repacking. Generated artifacts
are keyed by catalog, taxonomy, and solver versions; future per-island caches
can reuse unaffected local solves without changing the public file format.

The map lives on a larger two-dimensional stage with a separate camera layer.
It initially fits the whole atlas to the available viewport, refits while that
fit state is active and the viewport changes size, and supports mouse drag or
one-finger touch panning. Zoom spans 15–250%, stays anchored to the cursor,
pinch midpoint, or viewport center, and is available through ordinary wheel or
trackpad scrolling, two-finger pinching, buttons, keyboard shortcuts, and
double-click. The lower bound lets the fit control
contain the complete atlas even on narrow screens. The fit control changes only
the camera and never clears research filters. This gives dense families room to
breathe while preserving a viewport-height interface and stable world
coordinates.

The shaded island circles are restrained, borderless visual regions rather than
inferred statistical confidence areas; the experimental anchor does not need a
visible circle. The default “citations on this map” mode derives incoming counts
from the full verified mapped citation graph and scales perceived dot area with
a bounded `log(1 + citations)` transform from 12–28 pixels. A uniform-size
toggle remains available. The fixed citation scale keeps additions from
resizing every existing dot. Each mode has its own generated layout, so dots,
labels, and island circles remain separated. These are not global scholarly
citation totals or a proxy for evidence strength.

The detail panel lists the complete “cites” and “cited by” relationships among
mapped papers. Keeping citation lineage out of the spatial canvas avoids
confusing citation structure with conceptual distance and keeps dense papers
from producing a starburst of lines.

## Daily lifecycle

At 11:00 Europe/Rome every day, the scheduled task:

1. starts an atomic ledger run and plans coverage from the private completed
   cursor, not from the website's public update date;
2. fetches recent public HTML pages politely, records immutable announcement
   batches, and reuses unchanged batches in the overlap window;
3. advances the newest-first INSPIRE citation-neighbor frontier and the arXiv
   broad-phrase, exact observation identifier/title, and unique-author search
   frontiers only after complete coverage, while bounded overlapping category
   listings independently catch mapped-paper replacements; known IDs resurfacing
   in either path are hydrated to detect exact-version revisions;
4. fetches metadata for previously unseen IDs and arXiv versions, then emits a
   compact candidate bundle rather than placing raw pages or the full catalog in
   model context;
5. conservatively reviews those genuinely new or revised records for relevance
   to the isolated 248 keV candidate;
6. stores each affected paper's complete explicit arXiv reference set by version
   and derives mapped outgoing and reverse citation edges locally;
7. regenerates catalog and dual-layout artifacts and validates taxonomy, stable
   ranks, coordinates, citations, artifact digests, and geometry;
8. atomically completes all required lanes—even on a no-change day—or promotes
   no cursors if any lane was deferred, throttled, malformed, or incomplete;
9. writes a concise delta audit and opens a pull request only when public facts
   or the human-review queue changed.

Existing human-reviewed summaries, island memberships, coordinates, and layout
ranks remain fixed. New records are appended with the next rank. When a revision
makes one of those fields questionable, the task flags it for human review
instead of silently rewriting it. A revision to the
experimental anchor always creates a mandatory-review entry. If arXiv is
unavailable, the previous site remains untouched. A merge to `main` triggers a
fresh static build and GitHub Pages deployment. When a maintenance pull request
remains open, later scans pause to avoid overwriting reviewer edits or newer
corrections on `main`.

Uncertain and excluded decisions are keyed by paper version and evidence hash.
A later arXiv revision therefore becomes eligible for a new assessment without
re-reviewing unchanged versions.

## Research interface

The map supports title, author, concept, and arXiv-ID search; idea filtering;
inclusive publication-date windows; map and list views; keyboard-focusable
paper nodes and island explanations; uniform or mapped-citation dot sizing;
shareable `?paper=`, `?from=`, and `?to=` links; machine-summary labeling;
selectable “cites” and “cited by” lists; and direct links to each arXiv record.
The list view preserves access when spatial browsing is not useful or the
screen is narrow.

Distance means conceptual overlap, not evidential strength, consensus, paper
quality, or probability that an explanation is correct. Inclusion is neither
endorsement nor peer review.

## Reproducibility and review

Every meaningful scan writes a manifest under `data/runs/` with its timestamp,
per-lane coverage, public source pages, changed records, citation evidence, and
validation results. The candidate log preserves uncertain suggestions. Git
history then records exactly what a reviewer accepted. No-change coverage and
resumable checkpoints remain private in the task-local ledger, preventing audit
files and model memory from growing on routine days. Catalog validation also
requires layout ranks to be unique, contiguous integers, preventing a missing or
reused stability identity from reaching the site.

CI verifies generated catalog and layout digests before building. The pure
solver and current-catalog artifacts are checked in both sizing modes: every
primary paper and fixed label box must remain inside its circle, all nine
packing bodies (including the hidden LZ body) must remain separated, and input
reordering must produce byte-identical geometry. Compactness gates cover both a
deliberately strip-shaped fixture and every established island with at least ten
papers. Stress fixtures cover thousands of enclosing bodies and hundreds of
island nodes, dense/coincident bodies, invalid geometry, impossible viewports,
older-ID backfills, and edge-driven growth. Separate camera tests cover padded
fit, scale bounds, centered stages, anchor-preserving wheel and pinch zoom,
combined pinch translation, and edge clamping.
Ledger tests cover immutable evidence, fail-closed lane completion, no-change
cursors, reference snapshots, author deduplication, and safe recovery.

The next useful upgrades are manual field locks, a contribution/correction form
backed by GitHub Issues, and embeddings for suggesting conceptual neighbors
without drawing them as citation edges. None is required for the first public
version.

## Precedents and primary references

- [Paperscape](https://paperscape.org/) for the paper-as-circle, continent-like
  visual metaphor and stable incremental layout.
- [Open Knowledge Maps](https://openknowledgemaps.org/faq) for labeled topic
  regions and an explicit explanation of what proximity means.
- [Connected Papers](https://www.connectedpapers.com/about) for later
  citation-based relatedness.
- [arXiv announcement schedule](https://info.arxiv.org/help/availability.html).
- [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations).
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
