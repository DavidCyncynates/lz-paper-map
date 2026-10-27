import assert from 'node:assert/strict';
import test from 'node:test';

import { filterCatalogPapers } from '../lib/paper-filters.ts';

const papers = Object.freeze(
  [
    {
      id: 'before',
      primaryIsland: 'electroweak',
      published: '2026-09-01',
      contribution: 'new-bound',
    },
    {
      id: 'first',
      primaryIsland: 'electroweak',
      published: '2026-09-02',
      contribution: 'new-bound',
    },
    {
      id: 'candidate',
      primaryIsland: 'electroweak',
      published: '2026-09-03',
      contribution: 'candidate',
    },
    {
      id: 'last',
      primaryIsland: 'electroweak',
      published: '2026-09-04',
      contribution: 'new-bound',
    },
    {
      id: 'other-island',
      primaryIsland: 'endothermic',
      published: '2026-09-03',
      contribution: 'new-bound',
    },
    {
      id: 'other-text',
      primaryIsland: 'electroweak',
      published: '2026-09-03',
      contribution: 'new-bound',
    },
    {
      id: 'after',
      primaryIsland: 'electroweak',
      published: '2026-09-05',
      contribution: 'new-bound',
    },
    {
      id: 'both',
      primaryIsland: 'electroweak',
      published: '2026-09-03',
      contribution: 'candidate-and-bound',
    },
    {
      id: 'reassessment',
      primaryIsland: 'electroweak',
      published: '2026-09-03',
      contribution: 'bound-reassessment',
    },
  ].map(Object.freeze),
);

const searchIndex = new Map(
  papers.map((paper) => [
    paper.id,
    paper.id === 'other-text'
      ? 'higgsino collider limits'
      : 'higgsino solar capture',
  ]),
);

const allFilters = Object.freeze({
  query: '',
  islandId: 'all',
  dateRange: Object.freeze({ from: '2026-09-01', to: '2026-09-05' }),
  contribution: 'all',
});

const ids = (matches) => matches.map((paper) => paper.id);

test('contribution intersects search, physics category, and inclusive publication dates', () => {
  const matches = filterCatalogPapers(
    papers,
    {
      query: '  HÍGGSINO—SOLAR  ',
      islandId: 'electroweak',
      dateRange: { from: '2026-09-02', to: '2026-09-04' },
      contribution: 'new-bound',
    },
    searchIndex,
  );
  assert.deepEqual(ids(matches), ['first', 'last']);
});

test('candidate, both, and reassessment are separate exact contribution filters', () => {
  for (const [contribution, expected] of [
    ['candidate', ['candidate']],
    ['candidate-and-bound', ['both']],
    ['bound-reassessment', ['reassessment']],
  ]) {
    assert.deepEqual(
      ids(
        filterCatalogPapers(
          papers,
          { ...allFilters, contribution },
          searchIndex,
        ),
      ),
      expected,
    );
  }
});

test('clearing contribution preserves the other active filters', () => {
  const filters = {
    ...allFilters,
    query: 'solar',
    islandId: 'electroweak',
    dateRange: { from: '2026-09-03', to: '2026-09-03' },
  };
  assert.deepEqual(ids(filterCatalogPapers(papers, filters, searchIndex)), [
    'candidate',
    'both',
    'reassessment',
  ]);
});

test('incompatible filters and unknown exact values return no matches', () => {
  assert.deepEqual(
    filterCatalogPapers(
      papers,
      {
        ...allFilters,
        islandId: 'endothermic',
        contribution: 'candidate',
      },
      searchIndex,
    ),
    [],
  );
  assert.deepEqual(
    filterCatalogPapers(
      papers,
      {
        ...allFilters,
        contribution: 'invalid',
      },
      searchIndex,
    ),
    [],
  );
});

test('filtering preserves input records, catalog order, and the search index', () => {
  const beforePapers = JSON.stringify(papers);
  const beforeIndex = [...searchIndex.entries()];
  const matches = filterCatalogPapers(
    papers,
    {
      ...allFilters,
      contribution: 'new-bound',
    },
    searchIndex,
  );
  assert.deepEqual(ids(matches), [
    'before',
    'first',
    'last',
    'other-island',
    'other-text',
    'after',
  ]);
  assert.notEqual(matches, papers);
  assert.equal(matches[0], papers[0]);
  assert.equal(matches[1], papers[1]);
  assert.equal(JSON.stringify(papers), beforePapers);
  assert.deepEqual([...searchIndex.entries()], beforeIndex);
});

test('empty search and all sentinels return all papers even without search entries', () => {
  assert.deepEqual(
    filterCatalogPapers(
      papers,
      {
        ...allFilters,
        query: '   ',
      },
      new Map(),
    ),
    papers,
  );
  assert.deepEqual(filterCatalogPapers([], allFilters, new Map()), []);
});

test('a missing search entry cannot satisfy a nonempty text query', () => {
  assert.deepEqual(
    filterCatalogPapers(
      papers,
      {
        ...allFilters,
        query: 'solar',
      },
      new Map(),
    ),
    [],
  );
});
