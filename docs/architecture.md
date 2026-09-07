# Architecture

## Product principle

The LZ Paper Map is a small, reviewable research atlas. It treats the September
2026 LZ result as one isolated high-recoil candidate event, not as a confirmed
dark-matter signal or a broad excess. Each circle is a paper; distance encodes
shared physical ideas. Any line is a verified citation arrow pointing from the
citing paper to the cited paper; labels distinguish interpretations,
constraints, diagnostics, adjacent work, and the experimental result.

The public map is static. This makes it fast, inexpensive, easy to archive, and
compatible with GitHub Pages. All potentially contentious semantic changes are
ordinary version-controlled data changes.

## System shape

```text
arXiv Atom API
      │
      ▼
deterministic fetch, normalization, and relevance pre-filter
      │
      ▼
OpenAI structured output: relevance, role, existing idea IDs, neutral summary
      │
      ▼
schema checks + stable placement for new circles
      │
      ▼
daily review pull request ── human merge ── GitHub Pages deployment
```

There is no database or production server. The browser reads the committed
catalog in `data/landscape.json`, and the build exports plain static assets.
Project-site builds prefix asset URLs with the repository name and then flatten
the generated asset folder so GitHub Pages can mount the artifact at that path.

## Trust boundaries

- arXiv is authoritative for identifiers, titles, authors, dates, and links.
- The model may suggest only relevance, role, existing island membership, tags,
  a neutral summary, and a short inclusion rationale.
- Citation edges are checked separately against arXiv paper reference lists.
  References to the official LZ preprint are normalized to its mapped arXiv ID.
  The model never infers citations from abstracts, dates, or proximity.
- Titles and abstracts are passed to the model as explicitly untrusted quoted
  data. The model has no tools and cannot write to the repository.
- Model output must satisfy a strict JSON schema. Invalid output fails the run.
- Existing papers are never deleted or moved by the daily script.
- A high-confidence threshold is required for a proposed inclusion. Uncertain
  results stay in the candidate log for review.
- A safety cap stops the run if the search suddenly produces an implausibly
  large number of new candidates.
- The API key exists only as the `OPENAI_API_KEY` GitHub Actions secret.

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

The taxonomy is deliberately human-owned. A daily model call cannot create,
rename, split, or delete an island. A proposed taxonomy change should be a
separate, discussed atlas revision.

## Stable layout

Researchers should be able to build a mental map over time. For that reason,
the browser never runs a random or continuously moving force layout, and the
daily job does not rewrite existing semantic coordinates.

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

Citation arrows show both incoming and outgoing relationships for the selected
paper. A midpoint arrow keeps direction visible without colliding with either
paper circle. When more than eight connected papers are visible, the map omits
the lines rather than drawing a starburst. The detail panel always lists the
complete “cites” and “cited by” relationships among mapped papers, providing the
semantic fallback for keyboard, touch, and crowded cases.

## Daily lifecycle

At 05:17 UTC, the scheduled workflow:

1. makes one arXiv API query for LUX-ZEPLIN and event-specific phrases;
2. normalizes and deduplicates results;
3. refreshes source metadata for known IDs and detects new arXiv revisions;
4. sends genuinely new or revised, deterministically relevant records to the
   OpenAI Responses API using strict structured output;
5. validates taxonomy references, URLs, coordinates, roles, and citation IDs;
6. writes an auditable run manifest; and
7. opens or updates one pull request for human review.

Revised interpretation papers can receive refreshed summaries and idea
memberships, but retain their coordinates. A revision to the experimental anchor
is never summarized automatically: it creates a mandatory-review entry so a
human can update the event facts, summary, and takeaway while its role, island,
and coordinates stay locked. If arXiv or OpenAI is unavailable, the previous
site remains untouched. A merge to `main` triggers a fresh static build and
GitHub Pages deployment. When a review pull request remains open, later scans
pause. This prevents repeated model calls and avoids overwriting reviewer edits
or newer corrections on `main`.

Excluded and uncertain candidates retain their source update date. They are not
re-screened unchanged, but a later arXiv revision makes them eligible for a new
structured review.

## Research interface

The map supports title, author, concept, and arXiv-ID search; idea filtering;
map and list views; keyboard-focusable paper nodes; shareable `?paper=` links;
machine-summary labeling; directional citation arrows; selectable “cites” and
“cited by” lists; and direct links to each arXiv record. The list view preserves
access when spatial browsing is not useful or the screen is narrow.

Distance means conceptual overlap, not evidential strength, consensus, paper
quality, or probability that an explanation is correct. Inclusion is neither
endorsement nor peer review.

## Reproducibility and review

Every meaningful scan writes a manifest under `data/runs/` with its timestamp,
query endpoint, prompt version, model and response IDs, and result counts. The
candidate log preserves rejected and uncertain suggestions. Git history then
records exactly what a reviewer accepted.

The next useful upgrades are deterministic reference-list refreshes, manual
field locks, a contribution/correction form backed by GitHub Issues, periodic
refreshes of all known arXiv versions, and embeddings for suggesting conceptual
neighbors without drawing them as citation edges. None is required for the
first public version.

## Precedents and primary references

- [Paperscape](https://paperscape.org/) for the paper-as-circle, continent-like
  visual metaphor and stable incremental layout.
- [Open Knowledge Maps](https://openknowledgemaps.org/faq) for labeled topic
  regions and an explicit explanation of what proximity means.
- [Connected Papers](https://www.connectedpapers.com/about) for later
  citation-based relatedness.
- [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html) and
  [terms of use](https://info.arxiv.org/help/api/tou.html).
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
