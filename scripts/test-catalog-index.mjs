import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalogIndex,
  catalogDigest,
  normalizeSearchText,
  resolveCatalogIndex,
  validateCatalogIndex,
} from '../lib/catalog-index.mjs';

function fixtureCatalog() {
  return {
    schemaVersion: 1,
    taxonomyRevision: '2026-10-08',
    updatedAt: '2026-09-30',
    islands: [
      {
        id: 'inelastic',
        label: 'Inelastic dark matter',
        shortLabel: 'Inelastic DM',
        kicker: 'state-changing recoil',
      },
      {
        id: 'tests',
        label: 'Independent tests',
        shortLabel: 'Tests',
        kicker: 'other targets',
      },
    ],
    papers: [
      {
        id: 'a',
        arxivId: '2609.00001',
        title: 'Café-recoil signatures',
        authors: ['Áda Lovelace'],
        summary: 'A 248 ± 20 keV candidate.',
        takeaway: 'Tests a dark-photon model.',
        tags: ['dark matter'],
        islands: ['inelastic', 'tests'],
        cites: ['b', 'b', 'a', 'outside'],
      },
      {
        id: 'b',
        arxivId: '2609.00002',
        title: 'Second paper',
        authors: ['B. Author'],
        summary: '',
        takeaway: '',
        tags: [],
        islands: ['tests'],
        cites: [],
      },
      {
        id: 'c',
        arxivId: '2609.00003',
        title: 'Third paper',
        authors: ['C. Author'],
        summary: '',
        takeaway: '',
        tags: [],
        islands: ['inelastic'],
        cites: ['b'],
      },
    ],
  };
}

test('catalog index generation is byte-for-byte deterministic', () => {
  const catalog = fixtureCatalog();
  assert.equal(
    JSON.stringify(buildCatalogIndex(catalog)),
    JSON.stringify(buildCatalogIndex(structuredClone(catalog))),
  );
  assert.equal(catalogDigest(catalog), catalogDigest(structuredClone(catalog)));
});

test('reverse citations count unique mapped edges only', () => {
  const index = buildCatalogIndex(fixtureCatalog());
  assert.deepEqual(index.papers.a.citedBy, []);
  assert.deepEqual(index.papers.b.citedBy, ['a', 'c']);
  assert.equal(index.papers.b.incomingCitationCount, 2);
  assert.equal(index.edgeCount, 2);
  assert.equal(validateCatalogIndex(fixtureCatalog(), index).ok, true);
});

test('digest mismatch triggers a correct in-memory fallback', () => {
  const catalog = fixtureCatalog();
  const staleIndex = buildCatalogIndex(catalog);
  const changedCatalog = structuredClone(catalog);
  changedCatalog.papers[0].title = 'Changed title';
  const warnings = [];
  const resolved = resolveCatalogIndex(changedCatalog, staleIndex, {
    warn: (message) => warnings.push(message),
  });

  assert.equal(resolved.source, 'fallback');
  assert.equal(warnings.length, 1);
  assert.match(resolved.index.papers.a.searchText, /^changed title /);
  assert.match(resolved.errors.join(' '), /digest/);
});

test('search normalization removes diacritics and punctuation consistently', () => {
  assert.equal(
    normalizeSearchText('  Café — 248 ± 20 keV; Áxion\nRECOIL  '),
    'cafe 248 20 kev axion recoil',
  );
});

test('search text includes labels for every island membership', () => {
  const index = buildCatalogIndex(fixtureCatalog());
  assert.match(
    index.papers.a.searchText,
    /inelastic dark matter inelastic dm state changing recoil/,
  );
  assert.match(
    index.papers.a.searchText,
    /independent tests tests other targets/,
  );
});

test('taxonomy revision mismatch invalidates a generated index', () => {
  const catalog = fixtureCatalog();
  const index = buildCatalogIndex(catalog);
  const revisedCatalog = structuredClone(catalog);
  revisedCatalog.taxonomyRevision = '2026-10-09';

  const validation = validateCatalogIndex(revisedCatalog, index);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(' '), /taxonomy revision/);
});
