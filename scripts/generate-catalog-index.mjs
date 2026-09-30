import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalogIndex } from '../lib/catalog-index.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(projectRoot, 'data', 'landscape.json');
const outputPath = resolve(
  projectRoot,
  'data',
  'generated',
  'catalog-index.json',
);

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const serialized = `${JSON.stringify(buildCatalogIndex(catalog), null, 2)}\n`;
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  if (
    !existsSync(outputPath) ||
    readFileSync(outputPath, 'utf8') !== serialized
  ) {
    console.error(
      'data/generated/catalog-index.json is stale. Run node scripts/generate-catalog-index.mjs.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Catalog index is current for ${catalog.papers.length} papers.`,
    );
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  console.log(`Generated catalog index for ${catalog.papers.length} papers.`);
}
