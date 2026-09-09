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
      │
      ▼
local scheduled Codex review in an isolated worktree
      │
      ▼
reference verification + schema checks + stable placement
      │
      ▼
review pull request ── human merge ── GitHub Pages deployment
```

There is no database or production server. The browser reads the committed
catalog in `data/landscape.json`, and the build exports plain static assets.
Project-site builds prefix asset URLs with the repository name and then flatten
the generated asset folder so GitHub Pages can mount the artifact at that path.

## Trust boundaries

- arXiv is authoritative for identifiers, titles, authors, dates, and links.
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

`data/landscape.json` is the single source of truth for this first, small
corpus. Every paper stores canonical arXiv metadata, a role, one primary island,
up to two secondary islands, tags, machine-assisted explanatory text, stable
coordinates, and the mapped paper IDs that its reference list cites. Reverse
“cited by” lists are derived from those directional citations rather than stored
separately.

The first atlas uses nine fixed islands:

1. the LZ observation;
2. dark-matter absorption;
3. adjacent and multi-messenger signals;
4. neutrino-initiated new physics;
5. Higgsino and electroweak dark matter;
6. endothermic dark matter;
7. exothermic dark matter;
8. elastic momentum-dependent portals; and
9. constraints and discriminants.

The taxonomy is deliberately human-owned. The scheduled task cannot create,
rename, split, or delete an island. A proposed taxonomy change should be a
separate, discussed atlas revision.

## Stable layout

Researchers should be able to build a mental map over time. For that reason,
the browser never runs a random or continuously moving force layout, and the
scheduled task does not rewrite existing semantic coordinates.

Each island keeps a fixed semantic seed rather than a fixed visible boundary. A
new paper is attracted mostly toward its primary island and partly toward any
secondary islands. A hash of the arXiv ID provides deterministic jitter;
collision checks find the first unoccupied position. Existing coordinates remain
pinned as semantic anchors. At display time, a deterministic hierarchical solve
first assembles each primary island independently. Its label and paper dots have
short-range collision repulsion, while weak center attraction and authored
coordinate springs preserve a compact, recognizable local arrangement. An exact
minimum enclosing circle is calculated over the settled paper discs and all four
corners of the measured label, then padded to form the visible island.

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
or independently re-solved during this outer pass. Only the settled result is
rendered: there is no visible animation, and filtering does not reflow the map.
The browser reveals spatial geometry only after the actual label and dot extents
have been measured and both solver levels report convergence. If the available
world cannot satisfy containment, separation, or canvas bounds, the map stays
mounted but hidden so it can recover after a resize; an accessible message sends
the reader to the matching list view instead of displaying misleading overlaps.

Secondary memberships remain searchable and inform semantic placement, but do
not duplicate a paper across physical islands. Adding a paper can enlarge its
primary circle and trigger deterministic repacking without changing the
committed semantic coordinates.

The map lives on a larger two-dimensional stage that can be scrolled, dragged,
and zoomed. This gives dense families room to breathe while preserving a
viewport-height interface and a stable coordinate system.

The shaded island circles are restrained, borderless visual regions rather than
inferred statistical confidence areas; the experimental anchor does not need a
visible circle. Follow-up dot size is intentionally uniform, while the
experimental anchor is slightly larger. Citation counts are especially
misleading for papers only days old and do not affect the display.

The detail panel lists the complete “cites” and “cited by” relationships among
mapped papers. Keeping citation lineage out of the spatial canvas avoids
confusing citation structure with conceptual distance and keeps dense papers
from producing a starburst of lines.

## Daily lifecycle

At 12:00 Europe/Rome every day, the scheduled task:

1. completely enumerates the relevant public arXiv new/recent listings over a
   seven-day overlap and reads every plausibly related abstract, without
   requiring LZ language in the title;
2. searches broad standalone event phrases and identifiers, citation neighbors,
   and new-paper authors as independent discovery lanes;
3. deduplicates results by versionless arXiv ID and checks known abstract pages
   for new revisions;
4. conservatively screens genuinely new or revised records for relevance to the
   isolated 248 keV candidate;
5. verifies outgoing citations from each affected paper's current arXiv HTML
   reference list or PDF reference section;
6. on Sundays, reconciles the reference lists of every mapped paper to repair
   older omissions as well as changes associated with new revisions;
7. validates taxonomy references, URLs, coordinates, roles, and citation IDs;
8. records per-lane coverage and refuses to advance the successful-scan
   timestamp if a listing, pagination step, search, or discovery lane was
   incomplete;
9. writes a concise source audit when data changes; and
10. opens a new pull request for human review.

Existing human-reviewed summaries, island memberships, coordinates, and layout
ranks remain fixed. New records are appended with the next rank. When a revision
makes one of those fields questionable, the task flags it for human review
instead of silently rewriting it. A revision to the
experimental anchor always creates a mandatory-review entry. If arXiv is
unavailable, the previous site remains untouched. A merge to `main` triggers a
fresh static build and GitHub Pages deployment. When a maintenance pull request
remains open, later scans pause to avoid overwriting reviewer edits or newer
corrections on `main`.

Uncertain candidates retain their source update date for human review. A later
arXiv revision may make them eligible for a new assessment.

## Research interface

The map supports title, author, concept, and arXiv-ID search; idea filtering;
inclusive publication-date windows; map and list views; keyboard-focusable
paper nodes; shareable `?paper=`, `?from=`, and `?to=` links;
machine-summary labeling; selectable “cites” and “cited by” lists; and direct
links to each arXiv record. The list view preserves access when spatial browsing
is not useful or the screen is narrow.

Distance means conceptual overlap, not evidential strength, consensus, paper
quality, or probability that an explanation is correct. Inclusion is neither
endorsement nor peer review.

## Reproducibility and review

Every meaningful scan writes a manifest under `data/runs/` with its timestamp,
per-lane coverage, public source pages, changed records, citation evidence, and
validation results. The candidate log preserves uncertain suggestions. Git
history then records exactly what a reviewer accepted. Catalog validation also
requires layout ranks to be unique, contiguous integers, preventing a missing or
reused stability identity from reaching the site.

The pure solver and a conservative current-catalog geometry fixture are checked
in CI: every primary paper and label corner must remain inside its circle, all
nine packing bodies (including the hidden LZ body) must remain separated and
within the world, and reversing input order must produce byte-identical geometry.
The suite also covers scale-safe exact circles, dense/coincident bodies, invalid
geometry, an impossible viewport, and the displacement caused by adding one
later paper, including an older-ID backfill and an edge-growing placement.
Runtime convergence checks cover the browser's measured font and focus extents,
which cannot be known exactly in the Node-only fixture.

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
