import assert from 'node:assert/strict';
import test from 'node:test';

import catalogIndex from '../data/generated/catalog-index.json' with { type: 'json' };
import layouts from '../data/generated/map-layouts.json' with { type: 'json' };
import landscape from '../data/landscape.json' with { type: 'json' };
import {
  canonicalIslandLabelSize,
  ISLAND_GAP_PX,
  ISLAND_PADDING_PX,
  MAP_LAYOUT_SCHEMA_VERSION,
  MAP_LAYOUT_SOLVER_VERSION,
  mapPaperCollisionRadius,
  OBSERVATION_PACKING_PADDING_PX,
} from '../lib/map-layout-config.ts';

// Generated percentages and pixel geometry are rounded to three decimals.
// Derive the maximum geometric error from that serialization step rather than
// hiding real collisions behind an arbitrary epsilon.
const STORED_HALF_STEP = 0.0005;
const NUMERIC_TOLERANCE = 1e-9;

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pixelPoint(layout, point) {
  return {
    x: (point.x / 100) * layout.width,
    y: (point.y / 100) * layout.height,
  };
}

function storedPercentagePointError(layout) {
  return Math.hypot(
    layout.width * (STORED_HALF_STEP / 100),
    layout.height * (STORED_HALF_STEP / 100),
  );
}

function storedPixelPointError() {
  return Math.SQRT2 * STORED_HALF_STEP;
}

function pointPairRoundingTolerance(layout) {
  return 2 * storedPercentagePointError(layout) + NUMERIC_TOLERANCE;
}

function pointIslandRoundingTolerance(layout) {
  return (
    storedPercentagePointError(layout) +
    storedPixelPointError() +
    STORED_HALF_STEP +
    NUMERIC_TOLERANCE
  );
}

function islandPairRoundingTolerance() {
  return 2 * storedPixelPointError() + 2 * STORED_HALF_STEP + NUMERIC_TOLERANCE;
}

function circleRectangleClearance(circle, rectangle, size) {
  const horizontalDistance = Math.max(
    Math.abs(circle.x - rectangle.x) - size.width / 2,
    0,
  );
  const verticalDistance = Math.max(
    Math.abs(circle.y - rectangle.y) - size.height / 2,
    0,
  );
  return Math.hypot(horizontalDistance, verticalDistance);
}

test('generated layouts match the current catalog and solver schema', () => {
  assert.equal(layouts.schemaVersion, MAP_LAYOUT_SCHEMA_VERSION);
  assert.equal(layouts.solverVersion, MAP_LAYOUT_SOLVER_VERSION);
  assert.equal(layouts.sourceUpdatedAt, landscape.updatedAt);

  const expectedPaperIds = landscape.papers.map((paper) => paper.id).sort();
  const expectedIslandIds = landscape.islands.map((island) => island.id).sort();
  for (const mode of ['uniform', 'citations']) {
    const layout = layouts.modes[mode];
    assert.equal(layout.diagnostics.converged, true);
    assert.deepEqual(Object.keys(layout.papers).sort(), expectedPaperIds);
    assert.deepEqual(Object.keys(layout.labels).sort(), expectedIslandIds);
    assert.deepEqual(Object.keys(layout.islands).sort(), expectedIslandIds);
  }
});

for (const mode of ['uniform', 'citations']) {
  test(`${mode} artifact contains dots and labels inside separated islands`, () => {
    const layout = layouts.modes[mode];
    const pointIslandTolerance = pointIslandRoundingTolerance(layout);

    for (const paper of landscape.papers) {
      const position = pixelPoint(layout, layout.papers[paper.id]);
      const island = layout.islands[paper.primaryIsland];
      const citationCount =
        catalogIndex.papers[paper.id]?.incomingCitationCount ?? 0;
      const paperRadius = mapPaperCollisionRadius(paper, mode, citationCount);
      const padding =
        paper.primaryIsland === 'observation'
          ? OBSERVATION_PACKING_PADDING_PX
          : ISLAND_PADDING_PX;
      assert.ok(
        distance(position, island) + paperRadius + padding <=
          island.radius + pointIslandTolerance,
        `${paper.id} escapes ${paper.primaryIsland} in ${mode} mode`,
      );
    }

    for (const islandRecord of landscape.islands) {
      const label = pixelPoint(layout, layout.labels[islandRecord.id]);
      const circle = layout.islands[islandRecord.id];
      const size = canonicalIslandLabelSize(islandRecord);
      const padding =
        islandRecord.id === 'observation'
          ? OBSERVATION_PACKING_PADDING_PX
          : ISLAND_PADDING_PX;
      for (const horizontalSign of [-1, 1]) {
        for (const verticalSign of [-1, 1]) {
          const corner = {
            x: label.x + horizontalSign * (size.width / 2),
            y: label.y + verticalSign * (size.height / 2),
          };
          assert.ok(
            distance(corner, circle) + padding <=
              circle.radius + pointIslandTolerance,
            `${islandRecord.id} label escapes in ${mode} mode`,
          );
        }
      }
    }

    const circles = Object.entries(layout.islands);
    for (let firstIndex = 0; firstIndex < circles.length; firstIndex += 1) {
      const [firstId, first] = circles[firstIndex];
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < circles.length;
        secondIndex += 1
      ) {
        const [secondId, second] = circles[secondIndex];
        assert.ok(
          distance(first, second) + islandPairRoundingTolerance() >=
            first.radius + second.radius + ISLAND_GAP_PX,
          `${firstId} overlaps ${secondId} in ${mode} mode`,
        );
      }
    }
  });

  test(`${mode} rounded artifact keeps papers clear of papers and labels`, () => {
    const layout = layouts.modes[mode];
    const roundingTolerance = pointPairRoundingTolerance(layout);
    const papers = landscape.papers.map((paper) => ({
      id: paper.id,
      point: pixelPoint(layout, layout.papers[paper.id]),
      radius: mapPaperCollisionRadius(
        paper,
        mode,
        catalogIndex.papers[paper.id]?.incomingCitationCount ?? 0,
      ),
    }));
    const labels = landscape.islands.map((island) => ({
      id: island.id,
      point: pixelPoint(layout, layout.labels[island.id]),
      size: canonicalIslandLabelSize(island),
    }));

    for (let firstIndex = 0; firstIndex < papers.length; firstIndex += 1) {
      const first = papers[firstIndex];
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < papers.length;
        secondIndex += 1
      ) {
        const second = papers[secondIndex];
        const clearance =
          distance(first.point, second.point) - first.radius - second.radius;
        assert.ok(
          clearance + roundingTolerance >= 0,
          `${first.id} overlaps ${second.id} by ${(-clearance).toFixed(4)}px ` +
            `after ${mode} artifact rounding`,
        );
      }

      for (const label of labels) {
        const clearance =
          circleRectangleClearance(first.point, label.point, label.size) -
          first.radius;
        assert.ok(
          clearance + roundingTolerance >= 0,
          `${first.id} overlaps the ${label.id} label by ` +
            `${(-clearance).toFixed(4)}px after ${mode} artifact rounding`,
        );
      }
    }
  });
}
