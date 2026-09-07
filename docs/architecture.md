# Architecture

## Product principle

The LZ Paper Map is a small, reviewable research atlas. It treats the September
2026 LZ result as one isolated high-recoil candidate event, not as a confirmed
dark-matter signal or a broad excess. Each circle is a paper; distance encodes
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

Each island has a fixed region. A new paper is attracted mostly toward its
primary island and partly toward any secondary islands. A hash of the arXiv ID
provides deterministic jitter; collision checks find the first unoccupied
position. Existing coordinates remain pinned as semantic anchors. At display
time, a deterministic relaxation pass gives papers and labels a small amount of
repulsion while attracting them back toward those anchors. Only the settled
positions are rendered: there is no visible animation, and filtering does not
reflow the map. Viewport and font metrics can produce small responsive
adjustments, and adding a paper can cause local spacing changes without altering
the committed atlas. A global change to the semantic coordinates remains an
explicit new atlas version reviewed like any other editorial change.

The shaded island blobs are restrained visual regions rather than inferred
statistical confidence areas; the experimental anchor does not need a separate
blob. Follow-up circle size is intentionally uniform, while the experimental
anchor is slightly larger. Citation counts are especially misleading for papers
only days old and do not affect the display.

The detail panel lists the complete “cites” and “cited by” relationships among
mapped papers. Keeping citation lineage out of the spatial canvas avoids
confusing citation structure with conceptual distance and keeps dense papers
from producing a starburst of lines.

## Daily lifecycle

At 23:00 US Eastern, Sunday through Thursday, the scheduled task:

1. inspects arXiv's public new-listing and search pages for LUX-ZEPLIN and
   event-specific phrases, with an overlap window for delayed or missed runs;
2. deduplicates results by versionless arXiv ID and checks known abstract pages
   for new revisions;
3. conservatively screens genuinely new or revised records for relevance to the
   isolated 248 keV candidate;
4. verifies outgoing citations from each affected paper's current arXiv HTML
   reference list or PDF reference section;
5. on Sundays, reconciles the reference lists of every mapped paper to repair
   older omissions as well as changes associated with new revisions;
6. validates taxonomy references, URLs, coordinates, roles, and citation IDs;
7. writes a concise source audit when data changes; and
8. opens a new pull request for human review.

Existing human-reviewed summaries, island memberships, and coordinates remain
fixed. When a revision makes one of those fields questionable, the task flags it
for human review instead of silently rewriting it. A revision to the
experimental anchor always creates a mandatory-review entry. If arXiv is
unavailable, the previous site remains untouched. A merge to `main` triggers a
fresh static build and GitHub Pages deployment. When a maintenance pull request
remains open, later scans pause to avoid overwriting reviewer edits or newer
corrections on `main`.

Uncertain candidates retain their source update date for human review. A later
arXiv revision may make them eligible for a new assessment.

## Research interface

The map supports title, author, concept, and arXiv-ID search; idea filtering;
map and list views; keyboard-focusable paper nodes; shareable `?paper=` links;
machine-summary labeling; selectable “cites” and “cited by” lists; and direct
links to each arXiv record. The list view preserves access when spatial browsing
is not useful or the screen is narrow.

Distance means conceptual overlap, not evidential strength, consensus, paper
quality, or probability that an explanation is correct. Inclusion is neither
endorsement nor peer review.

## Reproducibility and review

Every meaningful scan writes a manifest under `data/runs/` with its timestamp,
public source pages, changed records, citation evidence, and validation results.
The candidate log preserves uncertain suggestions. Git history then records
exactly what a reviewer accepted.

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
