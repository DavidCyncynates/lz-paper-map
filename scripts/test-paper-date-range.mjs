import assert from 'node:assert/strict';
import test from 'node:test';

import landscape from '../data/landscape.json' with { type: 'json' };
import {
  applyDateRangeToSearchParams,
  dateRangeFromSearchParams,
  dayIndexToIsoDate,
  formatDateField,
  isFullDateRange,
  isoDateToDayIndex,
  normalizeDateRange,
  paperInDateRange,
  parseDateField,
  parseIsoDate,
  publicationDateBounds,
} from '../lib/paper-date-range.ts';

const BOUNDS = { from: '2026-09-01', to: '2026-09-08' };

test('date fields accept short input and render an unambiguous year', () => {
  assert.equal(parseDateField('01/09/26'), '2026-09-01');
  assert.equal(parseDateField('1/9/2026'), '2026-09-01');
  assert.equal(parseDateField(' 29/02/24 '), '2024-02-29');
  assert.equal(formatDateField('2026-09-01'), '01/09/2026');
  assert.equal(formatDateField('2024-02-29'), '29/02/2024');

  for (const invalid of [
    '',
    '2026-09-01',
    '29/02/26',
    '31/04/26',
    '01/13/26',
  ]) {
    assert.equal(parseDateField(invalid), null);
  }
  assert.throws(() => formatDateField('2026-02-29'), RangeError);
});

test('URL dates require strict, real ISO calendar dates', () => {
  assert.equal(parseIsoDate('2026-09-02'), '2026-09-02');
  for (const invalid of [
    '02/09/2026',
    '2026-02-29',
    '2026-09-02T00:00:00Z',
    '2026-9-2',
  ]) {
    assert.equal(parseIsoDate(invalid), null);
  }
});

test('publication filtering includes both endpoints', () => {
  const range = { from: '2026-09-02', to: '2026-09-04' };
  assert.equal(paperInDateRange({ published: '2026-09-01' }, range), false);
  assert.equal(paperInDateRange({ published: '2026-09-02' }, range), true);
  assert.equal(paperInDateRange({ published: '2026-09-04' }, range), true);
  assert.equal(paperInDateRange({ published: '2026-09-05' }, range), false);
});

test('ranges default, clamp, and recover from crossed endpoints', () => {
  assert.deepEqual(normalizeDateRange({}, BOUNDS), BOUNDS);
  assert.deepEqual(normalizeDateRange({ from: '2026-09-03' }, BOUNDS), {
    from: '2026-09-03',
    to: BOUNDS.to,
  });
  assert.deepEqual(normalizeDateRange({ to: '2026-09-05' }, BOUNDS), {
    from: BOUNDS.from,
    to: '2026-09-05',
  });
  assert.deepEqual(
    normalizeDateRange({ from: '2026-08-20', to: '2026-10-04' }, BOUNDS),
    BOUNDS,
  );
  assert.deepEqual(
    normalizeDateRange({ from: '2026-09-07', to: '2026-09-03' }, BOUNDS),
    { from: '2026-09-03', to: '2026-09-07' },
  );
  assert.equal(isFullDateRange(BOUNDS, BOUNDS), true);
  assert.equal(
    isFullDateRange({ from: BOUNDS.from, to: '2026-09-07' }, BOUNDS),
    false,
  );
});

test('date sliders use consecutive UTC day indices', () => {
  const fixtures = [
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
    '2026-12-31',
    '2027-01-01',
  ];
  for (const date of fixtures) {
    assert.equal(dayIndexToIsoDate(isoDateToDayIndex(date)), date);
  }
  assert.equal(
    isoDateToDayIndex('2024-02-29') - isoDateToDayIndex('2024-02-28'),
    1,
  );
  assert.equal(
    isoDateToDayIndex('2027-01-01') - isoDateToDayIndex('2026-12-31'),
    1,
  );
});

test('shared URLs preserve unrelated parameters and omit a full range', () => {
  const decoded = dateRangeFromSearchParams(
    new URLSearchParams('paper=2609.02823&from=2026-09-07&to=2026-09-03'),
    BOUNDS,
  );
  assert.deepEqual(decoded, {
    from: '2026-09-03',
    to: '2026-09-07',
  });

  const active = applyDateRangeToSearchParams(
    new URLSearchParams('paper=2609.02823'),
    { from: '2026-09-02', to: '2026-09-07' },
    BOUNDS,
  );
  assert.equal(
    active.toString(),
    'paper=2609.02823&from=2026-09-02&to=2026-09-07',
  );

  const reset = applyDateRangeToSearchParams(active, BOUNDS, BOUNDS);
  assert.equal(reset.toString(), 'paper=2609.02823');
  assert.deepEqual(
    dateRangeFromSearchParams(
      new URLSearchParams('from=not-a-date&to=2026-09-04'),
      BOUNDS,
    ),
    { from: BOUNDS.from, to: '2026-09-04' },
  );
});

test('catalog bounds and filtering use original publication dates', () => {
  const publishedDates = landscape.papers.map((paper) => paper.published);
  const bounds = publicationDateBounds(landscape.papers);
  assert.deepEqual(bounds, {
    from: publishedDates.reduce((earliest, date) =>
      date < earliest ? date : earliest,
    ),
    to: publishedDates.reduce((latest, date) =>
      date > latest ? date : latest,
    ),
  });
  for (const paper of landscape.papers) {
    assert.equal(paperInDateRange(paper, bounds), true);
  }

  const revisedPaper = landscape.papers.find(
    (paper) => paper.updated !== paper.published,
  );
  assert.ok(revisedPaper);
  assert.notEqual(revisedPaper.published, revisedPaper.updated);
  assert.equal(
    paperInDateRange(revisedPaper, {
      from: revisedPaper.published,
      to: revisedPaper.published,
    }),
    true,
  );
  assert.equal(
    paperInDateRange(revisedPaper, {
      from: revisedPaper.updated,
      to: revisedPaper.updated,
    }),
    false,
  );
});
