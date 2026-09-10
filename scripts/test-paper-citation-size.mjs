import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CITATION_DIAMETER_MAX_PX,
  CITATION_DIAMETER_MIN_PX,
  CITATION_SCALE_REFERENCE,
  citationDiameter,
  incomingCitationCounts,
} from '../lib/paper-citation-size.ts';

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test('incoming citation counts reverse the mapped graph only', () => {
  const papers = [
    { id: 'a', cites: ['b', 'b', 'a', 'outside'] },
    { id: 'b', cites: ['a'] },
    { id: 'c', cites: [] },
  ];
  const original = structuredClone(papers);

  assert.deepEqual(Object.fromEntries(incomingCitationCounts(papers)), {
    a: 1,
    b: 1,
    c: 0,
  });
  assert.deepEqual(
    Object.fromEntries(incomingCitationCounts([...papers].reverse())),
    { c: 0, b: 1, a: 1 },
  );
  assert.deepEqual(papers, original);
});

test('citation diameters are bounded, monotonic, and logarithmic in area', () => {
  near(citationDiameter(0), CITATION_DIAMETER_MIN_PX);
  near(citationDiameter(-4), CITATION_DIAMETER_MIN_PX);
  near(citationDiameter(Number.NaN), CITATION_DIAMETER_MIN_PX);
  near(citationDiameter(CITATION_SCALE_REFERENCE), CITATION_DIAMETER_MAX_PX);
  near(citationDiameter(1_000_000), CITATION_DIAMETER_MAX_PX);

  const counts = [0, 1, 3, 15, 51, CITATION_SCALE_REFERENCE];
  const diameters = counts.map((count) => citationDiameter(count));
  for (let index = 1; index < diameters.length; index += 1) {
    assert.ok(diameters[index] > diameters[index - 1]);
  }

  const normalizedArea = (count) => {
    const diameter = citationDiameter(count);
    return (
      (diameter ** 2 - CITATION_DIAMETER_MIN_PX ** 2) /
      (CITATION_DIAMETER_MAX_PX ** 2 - CITATION_DIAMETER_MIN_PX ** 2)
    );
  };
  near(
    normalizedArea(15),
    Math.log1p(15) / Math.log1p(CITATION_SCALE_REFERENCE),
  );
});

test('citation sizing rejects invalid visual bounds', () => {
  assert.throws(
    () => citationDiameter(2, { minimum: 20, maximum: 10 }),
    RangeError,
  );
  assert.throws(() => citationDiameter(2, { reference: 0 }), RangeError);
});
