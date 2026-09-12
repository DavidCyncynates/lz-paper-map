import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SITE_URL,
  renderSitemap,
} from './search-discovery.mjs';

const [repositoryOwner = '', repositoryName = ''] =
  process.env.GITHUB_REPOSITORY?.split('/') ?? [];
const isRootPage =
  repositoryName.toLowerCase() ===
  `${repositoryOwner.toLowerCase()}.github.io`;
const isProjectPage =
  process.env.GITHUB_ACTIONS === 'true' &&
  repositoryName.length > 0 &&
  !isRootPage;

const clientDirectory = join(process.cwd(), 'dist', 'client');
if (isProjectPage) {
  if (!/^[A-Za-z0-9._-]+$/.test(repositoryName)) {
    throw new Error(`Unsafe GitHub repository name: ${repositoryName}`);
  }

  const nestedAssetDirectory = join(clientDirectory, repositoryName, '_next');
  const pagesAssetDirectory = join(clientDirectory, '_next');

  if (!existsSync(nestedAssetDirectory)) {
    throw new Error(
      `Expected the static assets at ${nestedAssetDirectory}, but they were not built.`,
    );
  }

  if (existsSync(pagesAssetDirectory)) {
    rmSync(pagesAssetDirectory, { recursive: true, force: true });
  }
  renameSync(nestedAssetDirectory, pagesAssetDirectory);
  rmSync(join(clientDirectory, repositoryName), {
    recursive: true,
    force: true,
  });

  console.log(`Prepared static assets for /${repositoryName}/ on GitHub Pages.`);
}

const catalog = JSON.parse(
  readFileSync(join(process.cwd(), 'data', 'landscape.json'), 'utf8'),
);
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL;
writeFileSync(
  join(clientDirectory, 'sitemap.xml'),
  renderSitemap(catalog, siteUrl),
);
console.log(`Generated sitemap for ${catalog.papers.length} papers.`);
