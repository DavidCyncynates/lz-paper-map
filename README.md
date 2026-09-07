# LZ Paper Map

An island-like literature map for papers responding to the LUX-ZEPLIN high-
recoil candidate announced on 1 September 2026.

The first edition contains the LZ experimental paper and 21 response papers
available through the 7 September arXiv listing. Nearby circles share mechanisms
or phenomenology; the islands name the main families of ideas. Search, filters,
map/list views, paper details, and shareable paper links are built in.

This is a literature-navigation aid, not a statement of scientific consensus.
The LZ result is one roughly 248 keV candidate with 2.6σ global significance,
not a discovery. Placement and summaries are machine-assisted; metadata and
outgoing paper links come from arXiv.

## Architecture

The site is a static export hosted by GitHub Pages. A scheduled GitHub Action
queries arXiv daily, uses the OpenAI Responses API only for schema-constrained
semantic suggestions, validates the result, and opens a pull request. A human
merge publishes the update. Existing paper coordinates stay fixed during daily
updates so the map does not jump around.

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
pnpm build
```

The static site is written to `dist/client`.

## Publish on GitHub Pages

1. Create an empty GitHub repository and push this folder to its `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. In **Settings → Actions → General**, enable GitHub Actions to create pull
   requests for the repository.
4. In **Settings → Secrets and variables → Actions**, add a repository secret
   named `OPENAI_API_KEY`.
5. Optionally set an Actions variable named `OPENAI_MODEL`; it defaults to
   `gpt-5-mini`.
6. Run **Deploy GitHub Pages** once, or push a commit to `main`.

The Pages workflow automatically handles both a project address such as
`https://name.github.io/repository/` and a root user/organization Pages site.

The daily scan runs at 05:17 UTC. It never publishes directly: it opens or
updates the `automation/arxiv-daily` pull request for review. If there are no
changes, it does nothing. While that review pull request is open, later scans
pause rather than overwrite reviewer edits or newer corrections on `main`.

GitHub automatically disables scheduled workflows in public repositories after
60 days without repository activity. If the project has been quiet for that
long, re-enable the workflow from the Actions tab; use an external scheduler if
uninterrupted monitoring is essential.

## Editing the atlas

The public catalog is [data/landscape.json](data/landscape.json). Island IDs are
stable editorial concepts. To make a manual correction, edit the record, run
the validation command, and commit the change. To test ingestion without a
network call, pass a saved Atom feed with `--feed-file path/to/feed.xml`.

Successful scans that change data add an audit record under `data/runs/`.
Screened candidates, including uncertain or excluded records, are retained in
`data/candidates.json`.

Thank you to arXiv for use of its open-access interoperability.
