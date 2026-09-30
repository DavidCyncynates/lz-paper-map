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
    updatedAt: '2026-09-30',
    papers: [
      {
        id: 'a',
        arxivId: '2609.00001',
        title: 'Café-recoil signatures',
        authors: ['Áda Lovelace'],
        summary: 'A 248 ± 20 keV candidate.',
        takeaway: 'Tests a dark-photon model.',
        tags: ['dark matter'],
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
