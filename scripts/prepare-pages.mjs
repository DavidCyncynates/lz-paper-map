import {
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const [repositoryOwner = '', repositoryName = ''] =
  process.env.GITHUB_REPOSITORY?.split('/') ?? [];
const isRootPage =
  repositoryName.toLowerCase() ===
  `${repositoryOwner.toLowerCase()}.github.io`;
const isProjectPage =
  process.env.GITHUB_ACTIONS === 'true' &&
  repositoryName.length > 0 &&
  !isRootPage;

if (!isProjectPage) process.exit(0);
if (!/^[A-Za-z0-9._-]+$/.test(repositoryName)) {
  throw new Error(`Unsafe GitHub repository name: ${repositoryName}`);
}

const clientDirectory = join(process.cwd(), 'dist', 'client');
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
rmSync(join(clientDirectory, repositoryName), { recursive: true, force: true });

console.log(`Prepared static assets for /${repositoryName}/ on GitHub Pages.`);
