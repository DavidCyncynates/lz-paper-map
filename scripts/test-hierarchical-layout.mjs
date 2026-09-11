import assert from 'node:assert/strict';
import test from 'node:test';

import landscape from '../data/landscape.json' with { type: 'json' };
import {
  createHierarchicalMapLayout,
  createMinimumEnclosingCircle,
} from '../lib/hierarchical-map-layout.ts';
import {
  citationDiameter,
  incomingCitationCounts,
} from '../lib/paper-citation-size.ts';

const EPSILON = 1e-3;
const WIDTH = 1160;
const HEIGHT = 780;
const ISLAND_PADDING = 24;
const OBSERVATION_PADDING = 12;
const OUTER_GAP = 16;
const CANVAS_MARGIN = 14;
const PAPER_GAP = 8;
const LABEL_GAP = 9;
const ACTIVE_SCALE = 1.12;
const HALO = 5;
const FOLLOW_UP_RADIUS = (16 / 2 + HALO) * ACTIVE_SCALE;

function near(actual, expected, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function circleDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function mapSnapshot(layout) {
  return JSON.stringify({
    papers: [...layout.papers],
    labels: [...layout.labels],
    islands: [...layout.islands],
  });
}

function currentCatalogInputs(sizeMode = 'uniform') {
  const labelSizes = new Map(
    landscape.islands.map((island) => [
      island.id,
      {
        width: Math.max(
          92,
          island.label.length * 7.4 + 8,
          island.kicker.length * 5.5 + 8,
        ),
        height: 34,
      },
    ]),
  );
  const citationCounts = incomingCitationCounts(landscape.papers);
  const papers = landscape.papers.map((paper) => {
    const diameter =
      sizeMode === 'citations'
        ? citationDiameter(citationCounts.get(paper.id) ?? 0)
        : paper.role === 'observation'
          ? 28
          : 16;
    return {
      id: paper.id,
      islandId: paper.primaryIsland,
      stabilityRank: paper.layoutRank,
      x: (paper.x / 100) * WIDTH,
      y: (paper.y / 100) * HEIGHT,
      radius: (diameter / 2 + HALO) * ACTIVE_SCALE,
    };
  });
  const labels = landscape.islands.map((island) => {
    const size = labelSizes.get(island.id);
    return {
      id: island.id,
      islandId: island.id,
      x: ((island.x + island.width * 0.5) / 100) * WIDTH,
      y: ((island.y + island.height * 0.28) / 100) * HEIGHT,
      width: size.width,
      height: size.height,
    };
  });
  const islands = landscape.islands.map((island) => ({
    id: island.id,
    x: ((island.x + island.width * 0.5) / 100) * WIDTH,
    y: ((island.y + island.height * 0.5) / 100) * HEIGHT,
    observation: island.id === 'observation',
  }));
  return { papers, labels, islands, labelSizes };
}

test('minimum enclosing circle handles analytic disc fixtures', () => {
  const single = createMinimumEnclosingCircle([{ x: 3, y: -2, radius: 4 }]);
  assert.ok(single);
  near(single.x, 3);
  near(single.y, -2);
  near(single.radius, 4);

  const unequal = createMinimumEnclosingCircle([
    { x: 0, y: 0, radius: 4 },
    { x: 10, y: 0, radius: 2 },
  ]);
  assert.ok(unequal);
  near(unequal.x, 4);
  near(unequal.y, 0);
  near(unequal.radius, 8);

  const contained = createMinimumEnclosingCircle([
    { x: 0, y: 0, radius: 6 },
    { x: 1, y: 1, radius: 2 },
  ]);
  assert.ok(contained);
  near(contained.x, 0);
  near(contained.y, 0);
  near(contained.radius, 6);
});

test('minimum enclosing circle handles labels and three-body support', () => {
  const rectangle = createMinimumEnclosingCircle([
    { x: -3, y: -4, radius: 0 },
    { x: 3, y: -4, radius: 0 },
    { x: 3, y: 4, radius: 0 },
    { x: -3, y: 4, radius: 0 },
  ]);
  assert.ok(rectangle);
  near(rectangle.x, 0);
  near(rectangle.y, 0);
  near(rectangle.radius, 5);

  const height = Math.sqrt(3) * 5;
  const triangle = createMinimumEnclosingCircle([
    { x: 0, y: 0, radius: 2 },
    { x: 10, y: 0, radius: 2 },
    { x: 5, y: height, radius: 2 },
  ]);
  assert.ok(triangle);
  near(triangle.x, 5);
  near(triangle.y, height / 3);
  near(triangle.radius, 10 / Math.sqrt(3) + 2);

  const unequalTriple = createMinimumEnclosingCircle([
    { x: 9, y: 0, radius: 1 },
    { x: -4, y: Math.sqrt(48), radius: 2 },
    { x: -3.5, y: -Math.sqrt(36.75), radius: 3 },
  ]);
  assert.ok(unequalTriple);
  near(unequalTriple.x, 0);
  near(unequalTriple.y, 0);
  near(unequalTriple.radius, 10);

  const tinyAcuteTriangle = createMinimumEnclosingCircle([
    { x: 0, y: 0, radius: 0 },
    { x: 0.0001, y: 0, radius: 0 },
    { x: 0.00004, y: 0.00008, radius: 0 },
  ]);
  assert.ok(tinyAcuteTriangle);
  near(tinyAcuteTriangle.x, 0.00005, 1e-10);
  near(tinyAcuteTriangle.y, 0.000025, 1e-10);
  near(
    tinyAcuteTriangle.radius,
    Math.sqrt(0.00005 ** 2 + 0.000025 ** 2),
    1e-10,
  );

  const obtuseTriangle = createMinimumEnclosingCircle([
    { x: 0, y: 0, radius: 0 },
    { x: 4, y: 0, radius: 0 },
    { x: 1, y: 1, radius: 0 },
  ]);
  assert.ok(obtuseTriangle);
  near(obtuseTriangle.x, 2);
  near(obtuseTriangle.y, 0);
  near(obtuseTriangle.radius, 2);

  const translatedRectangle = createMinimumEnclosingCircle([
    { x: 1_000_000_000 - 3, y: -1_000_000_000 - 4, radius: 0 },
    { x: 1_000_000_000 + 3, y: -1_000_000_000 - 4, radius: 0 },
    { x: 1_000_000_000 + 3, y: -1_000_000_000 + 4, radius: 0 },
    { x: 1_000_000_000 - 3, y: -1_000_000_000 + 4, radius: 0 },
  ]);
  assert.ok(translatedRectangle);
  near(translatedRectangle.x, 1_000_000_000, 1e-5);
  near(translatedRectangle.y, -1_000_000_000, 1e-5);
  near(translatedRectangle.radius, 5, 1e-5);
});

test('current catalog is contained, separated, bounded, and deterministic', () => {
  const { papers, labels, islands, labelSizes } = currentCatalogInputs();
  const options = {
    islandPadding: ISLAND_PADDING,
    observationPadding: OBSERVATION_PADDING,
    outerGap: OUTER_GAP,
  };
  const layout = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    papers,
    labels,
    islands,
    options,
  );
  const reversed = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    [...papers].reverse(),
    [...labels].reverse(),
    [...islands].reverse(),
    options,
  );

  assert.equal(layout.papers.size, landscape.papers.length);
  assert.equal(layout.labels.size, landscape.islands.length);
  assert.equal(layout.islands.size, landscape.islands.length);
  assert.equal(layout.diagnostics.converged, true);
  assert.equal(layout.diagnostics.exactEnclosures, true);
  assert.ok(layout.diagnostics.maxInnerOverlap <= EPSILON);
  assert.ok(layout.diagnostics.maxOuterOverlap <= EPSILON);
  assert.ok(layout.diagnostics.maxCanvasOverflow <= EPSILON);
  assert.equal(mapSnapshot(layout), mapSnapshot(reversed));

  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  for (const paper of landscape.papers) {
    const point = layout.papers.get(paper.id);
    const circle = layout.islands.get(paper.primaryIsland);
    const body = papersById.get(paper.id);
    const padding =
      paper.primaryIsland === 'observation'
        ? OBSERVATION_PADDING
        : ISLAND_PADDING;
    assert.ok(point && circle && body);
    assert.ok(
      circleDistance(point, circle) + body.radius + padding <=
        circle.radius + EPSILON,
      `${paper.id} escaped ${paper.primaryIsland}`,
    );
  }

  for (const island of landscape.islands) {
    const point = layout.labels.get(island.id);
    const circle = layout.islands.get(island.id);
    const size = labelSizes.get(island.id);
    const padding =
      island.id === 'observation' ? OBSERVATION_PADDING : ISLAND_PADDING;
    assert.ok(point && circle && size);
    near(circle.contentRadius + circle.padding, circle.radius);
    near(circle.padding, padding);
    assert.equal(circle.observation, island.id === 'observation');
    assert.equal(circle.drawBoundary, island.id !== 'observation');
    assert.ok(Number.isFinite(circle.anchorDrift));
    for (const horizontalSign of [-1, 1]) {
      for (const verticalSign of [-1, 1]) {
        const corner = {
          x: point.x + horizontalSign * (size.width / 2),
          y: point.y + verticalSign * (size.height / 2),
        };
        assert.ok(
          circleDistance(corner, circle) + padding <= circle.radius + EPSILON,
          `${island.id} label escaped its circle`,
        );
      }
    }
  }

  const packedCircles = [...layout.islands].sort(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0,
  );
  for (let firstIndex = 0; firstIndex < packedCircles.length; firstIndex += 1) {
    const [firstId, first] = packedCircles[firstIndex];
    assert.ok(first.x - first.radius >= CANVAS_MARGIN - EPSILON);
    assert.ok(first.y - first.radius >= CANVAS_MARGIN - EPSILON);
    assert.ok(first.x + first.radius <= WIDTH - CANVAS_MARGIN + EPSILON);
    assert.ok(first.y + first.radius <= HEIGHT - CANVAS_MARGIN + EPSILON);
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < packedCircles.length;
      secondIndex += 1
    ) {
      const [secondId, second] = packedCircles[secondIndex];
      assert.ok(
        circleDistance(first, second) + EPSILON >=
          first.radius + second.radius + OUTER_GAP,
        `${firstId} overlaps ${secondId}`,
      );
    }
  }

  const primaryGroups = Map.groupBy(
    landscape.papers,
    (paper) => paper.primaryIsland,
  );
  for (const [islandId, members] of primaryGroups) {
    for (let firstIndex = 0; firstIndex < members.length; firstIndex += 1) {
      const first = members[firstIndex];
      const firstPoint = layout.papers.get(first.id);
      const firstBody = papersById.get(first.id);
      assert.ok(firstPoint && firstBody);
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < members.length;
        secondIndex += 1
      ) {
        const second = members[secondIndex];
        const secondPoint = layout.papers.get(second.id);
        const secondBody = papersById.get(second.id);
        assert.ok(secondPoint && secondBody);
        assert.ok(
          circleDistance(firstPoint, secondPoint) + EPSILON >=
            firstBody.radius + secondBody.radius + PAPER_GAP,
          `${first.id} overlaps ${second.id}`,
        );
      }

      const labelPoint = layout.labels.get(islandId);
      const label = labelsById.get(islandId);
      assert.ok(labelPoint && label);
      const horizontalDistance = Math.max(
        Math.abs(firstPoint.x - labelPoint.x) - label.width / 2,
        0,
      );
      const verticalDistance = Math.max(
        Math.abs(firstPoint.y - labelPoint.y) - label.height / 2,
        0,
      );
      assert.ok(
        Math.hypot(horizontalDistance, verticalDistance) + EPSILON >=
          firstBody.radius + LABEL_GAP,
        `${first.id} overlaps the ${islandId} label`,
      );
    }
  }
});

test('citation-sized catalog remains contained, separated, and deterministic', () => {
  const citationInputs = currentCatalogInputs('citations');
  const uniformInputs = currentCatalogInputs('uniform');
  const options = {
    islandPadding: ISLAND_PADDING,
    observationPadding: OBSERVATION_PADDING,
    outerGap: OUTER_GAP,
  };
  const layout = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    citationInputs.papers,
    citationInputs.labels,
    citationInputs.islands,
    options,
  );
  const reversed = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    [...citationInputs.papers].reverse(),
    [...citationInputs.labels].reverse(),
    [...citationInputs.islands].reverse(),
    options,
  );
  const uniformBefore = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    uniformInputs.papers,
    uniformInputs.labels,
    uniformInputs.islands,
    options,
  );
  const uniformAfter = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    uniformInputs.papers,
    uniformInputs.labels,
    uniformInputs.islands,
    options,
  );

  assert.equal(layout.diagnostics.converged, true);
  assert.equal(layout.diagnostics.exactEnclosures, true);
  assert.ok(layout.diagnostics.maxInnerOverlap <= EPSILON);
  assert.ok(layout.diagnostics.maxOuterOverlap <= EPSILON);
  assert.ok(layout.diagnostics.maxCanvasOverflow <= EPSILON);
  assert.equal(mapSnapshot(layout), mapSnapshot(reversed));
  assert.equal(mapSnapshot(uniformBefore), mapSnapshot(uniformAfter));
  assert.notEqual(mapSnapshot(layout), mapSnapshot(uniformBefore));

  const papersById = new Map(
    citationInputs.papers.map((paper) => [paper.id, paper]),
  );
  for (const paper of landscape.papers) {
    const body = papersById.get(paper.id);
    const point = layout.papers.get(paper.id);
    const circle = layout.islands.get(paper.primaryIsland);
    const padding =
      paper.primaryIsland === 'observation'
        ? OBSERVATION_PADDING
        : ISLAND_PADDING;
    assert.ok(body && point && circle);
    assert.ok(
      circleDistance(point, circle) + body.radius + padding <=
        circle.radius + EPSILON,
      `${paper.id} escaped ${paper.primaryIsland} in citation mode`,
    );
  }

  const primaryGroups = Map.groupBy(
    landscape.papers,
    (paper) => paper.primaryIsland,
  );
  for (const members of primaryGroups.values()) {
    for (let firstIndex = 0; firstIndex < members.length; firstIndex += 1) {
      const first = members[firstIndex];
      const firstPoint = layout.papers.get(first.id);
      const firstBody = papersById.get(first.id);
      assert.ok(firstPoint && firstBody);
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < members.length;
        secondIndex += 1
      ) {
        const second = members[secondIndex];
        const secondPoint = layout.papers.get(second.id);
        const secondBody = papersById.get(second.id);
        assert.ok(secondPoint && secondBody);
        assert.ok(
          circleDistance(firstPoint, secondPoint) + EPSILON >=
            firstBody.radius + secondBody.radius + PAPER_GAP,
          `${first.id} overlaps ${second.id} in citation mode`,
        );
      }
    }
  }
});

test('append-only additions preserve the established mental map, including backfills', () => {
  const { papers, labels, islands } = currentCatalogInputs();
  const options = {
    islandPadding: ISLAND_PADDING,
    observationPadding: OBSERVATION_PADDING,
    outerGap: OUTER_GAP,
  };
  const before = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    papers,
    labels,
    islands,
    options,
  );
  assert.equal(before.diagnostics.converged, true);

  for (const newPaperId of ['9999.99991', '0001.00001']) {
    const newPaper = {
      id: newPaperId,
      islandId: 'endothermic',
      stabilityRank: papers.length,
      x: 0.63 * WIDTH,
      y: 0.495 * HEIGHT,
      radius: FOLLOW_UP_RADIUS,
    };
    const after = createHierarchicalMapLayout(
      WIDTH,
      HEIGHT,
      [...papers, newPaper],
      labels,
      islands,
      options,
    );

    assert.equal(after.diagnostics.converged, true);
    assert.equal(after.papers.size, before.papers.size + 1);
    assert.ok(after.papers.has(newPaper.id));
    for (const paper of papers) {
      const beforePoint = before.papers.get(paper.id);
      const afterPoint = after.papers.get(paper.id);
      const beforeIsland = before.islands.get(paper.islandId);
      const afterIsland = after.islands.get(paper.islandId);
      assert.ok(beforePoint && afterPoint && beforeIsland && afterIsland);
      const worldDisplacement = circleDistance(beforePoint, afterPoint);
      assert.ok(
        worldDisplacement <= 24,
        `${paper.id} moved ${worldDisplacement}px after adding ${newPaperId}`,
      );

      const localDisplacement = circleDistance(
        {
          x: beforePoint.x - beforeIsland.x,
          y: beforePoint.y - beforeIsland.y,
        },
        {
          x: afterPoint.x - afterIsland.x,
          y: afterPoint.y - afterIsland.y,
        },
      );
      if (paper.islandId === 'endothermic') {
        assert.ok(
          localDisplacement <= 18,
          `${paper.id} moved ${localDisplacement}px within its island after adding ${newPaperId}`,
        );
      } else {
        near(localDisplacement, 0, 1e-9);
      }
    }

    for (const [islandId, beforeIsland] of before.islands) {
      const afterIsland = after.islands.get(islandId);
      assert.ok(afterIsland);
      assert.ok(
        circleDistance(beforeIsland, afterIsland) <= 12,
        `${islandId} shifted too far after adding ${newPaperId}`,
      );

      const beforeLabel = before.labels.get(islandId);
      const afterLabel = after.labels.get(islandId);
      assert.ok(beforeLabel && afterLabel);
      const worldLabelDisplacement = circleDistance(beforeLabel, afterLabel);
      assert.ok(
        worldLabelDisplacement <= 24,
        `${islandId} label moved ${worldLabelDisplacement}px after adding ${newPaperId}`,
      );
      const localLabelDisplacement = circleDistance(
        {
          x: beforeLabel.x - beforeIsland.x,
          y: beforeLabel.y - beforeIsland.y,
        },
        {
          x: afterLabel.x - afterIsland.x,
          y: afterLabel.y - afterIsland.y,
        },
      );
      if (islandId === 'endothermic') {
        assert.ok(
          localLabelDisplacement <= 18,
          `${islandId} label moved ${localLabelDisplacement}px locally after adding ${newPaperId}`,
        );
      } else {
        near(localLabelDisplacement, 0, 1e-9);
      }
    }

    const newPoint = after.papers.get(newPaper.id);
    const newIsland = after.islands.get(newPaper.islandId);
    const labelPoint = after.labels.get(newPaper.islandId);
    const label = labels.find(
      (candidate) => candidate.id === newPaper.islandId,
    );
    assert.ok(newPoint && newIsland && labelPoint && label);
    assert.ok(
      circleDistance(newPoint, newIsland) + newPaper.radius + ISLAND_PADDING <=
        newIsland.radius + EPSILON,
    );
    for (const establishedPaper of papers.filter(
      (paper) => paper.islandId === newPaper.islandId,
    )) {
      const establishedPoint = after.papers.get(establishedPaper.id);
      assert.ok(establishedPoint);
      assert.ok(
        circleDistance(newPoint, establishedPoint) + EPSILON >=
          newPaper.radius + establishedPaper.radius + PAPER_GAP,
        `${newPaper.id} overlaps ${establishedPaper.id}`,
      );
    }
    const horizontalDistance = Math.max(
      Math.abs(newPoint.x - labelPoint.x) - label.width / 2,
      0,
    );
    const verticalDistance = Math.max(
      Math.abs(newPoint.y - labelPoint.y) - label.height / 2,
      0,
    );
    assert.ok(
      Math.hypot(horizontalDistance, verticalDistance) + EPSILON >=
        newPaper.radius + LABEL_GAP,
      `${newPaper.id} overlaps the ${newPaper.islandId} label`,
    );
  }
});

test('dense append-only islands converge below the clearance tolerance', () => {
  for (const sizeMode of ['uniform', 'citations']) {
    const { papers, labels, islands } = currentCatalogInputs(sizeMode);
    const additions = [
      {
        id: '9999.99990',
        islandId: 'endothermic',
        stabilityRank: papers.length,
        x: 0.7437 * WIDTH,
        y: 0.552 * HEIGHT,
        radius: FOLLOW_UP_RADIUS,
      },
      {
        id: '9999.99991',
        islandId: 'endothermic',
        stabilityRank: papers.length + 1,
        x: 0.63 * WIDTH,
        y: 0.495 * HEIGHT,
        radius: FOLLOW_UP_RADIUS,
      },
    ];
    const layout = createHierarchicalMapLayout(
      WIDTH,
      HEIGHT,
      [...papers, ...additions],
      labels,
      islands,
      {
        islandPadding: ISLAND_PADDING,
        observationPadding: OBSERVATION_PADDING,
        outerGap: OUTER_GAP,
      },
    );

    assert.equal(layout.diagnostics.converged, true);
    assert.ok(
      layout.diagnostics.maxInnerOverlap <= EPSILON,
      `Expected ${sizeMode} inner overlap below ${EPSILON}px, received ${layout.diagnostics.maxInnerOverlap}px`,
    );
  }
});

test('an edge addition grows its island without large-scale map churn', () => {
  const { papers, labels, islands } = currentCatalogInputs();
  const options = {
    islandPadding: ISLAND_PADDING,
    observationPadding: OBSERVATION_PADDING,
    outerGap: OUTER_GAP,
  };
  const newPaper = {
    id: '2610.00206',
    islandId: 'endothermic',
    stabilityRank: papers.length,
    x: 0.7448 * WIDTH,
    y: 0.4585 * HEIGHT,
    radius: FOLLOW_UP_RADIUS,
  };
  const before = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    papers,
    labels,
    islands,
    options,
  );
  const after = createHierarchicalMapLayout(
    WIDTH,
    HEIGHT,
    [...papers, newPaper],
    labels,
    islands,
    options,
  );

  assert.equal(after.diagnostics.converged, true);
  assert.equal(after.papers.size, before.papers.size + 1);
  assert.ok(after.papers.has(newPaper.id));

  let maximumPaperDisplacement = 0;
  let maximumLocalPaperDisplacement = 0;
  for (const paper of papers) {
    const beforePoint = before.papers.get(paper.id);
    const afterPoint = after.papers.get(paper.id);
    const beforeIsland = before.islands.get(paper.islandId);
    const afterIsland = after.islands.get(paper.islandId);
    assert.ok(beforePoint && afterPoint && beforeIsland && afterIsland);
    maximumPaperDisplacement = Math.max(
      maximumPaperDisplacement,
      circleDistance(beforePoint, afterPoint),
    );
    maximumLocalPaperDisplacement = Math.max(
      maximumLocalPaperDisplacement,
      circleDistance(
        {
          x: beforePoint.x - beforeIsland.x,
          y: beforePoint.y - beforeIsland.y,
        },
        {
          x: afterPoint.x - afterIsland.x,
          y: afterPoint.y - afterIsland.y,
        },
      ),
    );
  }
  assert.ok(
    maximumPaperDisplacement <= 36,
    `An established paper moved ${maximumPaperDisplacement}px`,
  );
  assert.ok(
    maximumLocalPaperDisplacement <= 18,
    `An established paper moved ${maximumLocalPaperDisplacement}px within its island`,
  );

  let maximumIslandDisplacement = 0;
  let maximumLabelDisplacement = 0;
  let maximumLocalLabelDisplacement = 0;
  for (const [islandId, beforeIsland] of before.islands) {
    const afterIsland = after.islands.get(islandId);
    const beforeLabel = before.labels.get(islandId);
    const afterLabel = after.labels.get(islandId);
    assert.ok(afterIsland && beforeLabel && afterLabel);
    maximumIslandDisplacement = Math.max(
      maximumIslandDisplacement,
      circleDistance(beforeIsland, afterIsland),
    );
    maximumLabelDisplacement = Math.max(
      maximumLabelDisplacement,
      circleDistance(beforeLabel, afterLabel),
    );
    maximumLocalLabelDisplacement = Math.max(
      maximumLocalLabelDisplacement,
      circleDistance(
        {
          x: beforeLabel.x - beforeIsland.x,
          y: beforeLabel.y - beforeIsland.y,
        },
        {
          x: afterLabel.x - afterIsland.x,
          y: afterLabel.y - afterIsland.y,
        },
      ),
    );
  }
  assert.ok(
    maximumIslandDisplacement <= 36,
    `An island moved ${maximumIslandDisplacement}px`,
  );
  assert.ok(
    maximumLabelDisplacement <= 36,
    `An island label moved ${maximumLabelDisplacement}px`,
  );
  assert.ok(
    maximumLocalLabelDisplacement <= 18,
    `An island label moved ${maximumLocalLabelDisplacement}px within its island`,
  );

  const newPoint = after.papers.get(newPaper.id);
  const newIsland = after.islands.get(newPaper.islandId);
  assert.ok(newPoint && newIsland);
  assert.ok(
    circleDistance(newPoint, newIsland) + newPaper.radius + ISLAND_PADDING <=
      newIsland.radius + EPSILON,
  );
});

test('dense local bodies and the hidden observation participate in packing', () => {
  const papers = [
    {
      id: '1000.00001',
      islandId: 'idea',
      stabilityRank: 0,
      x: 180,
      y: 150,
      radius: 8,
    },
    {
      id: '1000.00002',
      islandId: 'idea',
      stabilityRank: 1,
      x: 180,
      y: 150,
      radius: 8,
    },
    {
      id: '1000.00003',
      islandId: 'idea',
      stabilityRank: 2,
      x: 180,
      y: 150,
      radius: 8,
    },
    {
      id: '1000.00004',
      islandId: 'source',
      stabilityRank: 3,
      x: 180,
      y: 150,
      radius: 12,
    },
  ];
  const labels = [
    {
      id: 'idea',
      islandId: 'idea',
      x: 180,
      y: 150,
      width: 210,
      height: 34,
    },
    {
      id: 'source',
      islandId: 'source',
      x: 180,
      y: 150,
      width: 72,
      height: 30,
    },
  ];
  const islands = [
    { id: 'idea', x: 180, y: 150 },
    { id: 'source', x: 180, y: 150, observation: true },
  ];
  const layout = createHierarchicalMapLayout(
    440,
    300,
    papers,
    labels,
    islands,
    { islandPadding: 18, observationPadding: 10, outerGap: 14 },
  );
  const idea = layout.islands.get('idea');
  const source = layout.islands.get('source');
  assert.ok(idea && source);
  assert.equal(layout.diagnostics.converged, true);
  assert.equal(source.drawBoundary, false);
  assert.ok(
    circleDistance(idea, source) + 1e-3 >=
      idea.radius + source.radius + 14 * 0.82,
  );
});

test('an impossible viewport returns finite, non-converged diagnostics', () => {
  const layout = createHierarchicalMapLayout(
    80,
    60,
    [],
    [
      { id: 'one', islandId: 'one', x: 40, y: 30, width: 100, height: 50 },
      { id: 'two', islandId: 'two', x: 40, y: 30, width: 100, height: 50 },
    ],
    [
      { id: 'one', x: 40, y: 30 },
      { id: 'two', x: 40, y: 30 },
    ],
  );
  assert.equal(layout.diagnostics.converged, false);
  assert.ok(
    layout.diagnostics.maxCanvasOverflow > 0 ||
      layout.diagnostics.maxOuterOverlap > 0,
  );
  for (const collection of [
    layout.papers.values(),
    layout.labels.values(),
    layout.islands.values(),
  ]) {
    for (const geometry of collection) {
      assert.ok(
        Object.values(geometry).every(
          (value) => typeof value !== 'number' || Number.isFinite(value),
        ),
      );
    }
  }
  assert.ok(
    Object.values(layout.diagnostics).every(
      (value) => typeof value !== 'number' || Number.isFinite(value),
    ),
  );
});

test('invalid and incomplete geometry fails closed', () => {
  assert.throws(
    () =>
      createHierarchicalMapLayout(
        200,
        200,
        [
          {
            id: 'paper',
            islandId: 'missing',
            stabilityRank: 0,
            x: 20,
            y: 20,
            radius: 5,
          },
        ],
        [],
        [],
      ),
    /Invalid geometry for paper/,
  );
  assert.throws(
    () =>
      createHierarchicalMapLayout(
        200,
        200,
        [
          {
            id: 'first',
            islandId: 'island',
            stabilityRank: 0,
            x: 80,
            y: 100,
            radius: 5,
          },
          {
            id: 'second',
            islandId: 'island',
            stabilityRank: 0,
            x: 120,
            y: 100,
            radius: 5,
          },
        ],
        [
          {
            id: 'island',
            islandId: 'island',
            x: 100,
            y: 100,
            width: 20,
            height: 10,
          },
        ],
        [{ id: 'island', x: 100, y: 100 }],
      ),
    /Invalid geometry for paper second/,
  );
  assert.throws(
    () =>
      createHierarchicalMapLayout(
        200,
        200,
        [],
        [],
        [{ id: 'empty', x: 100, y: 100 }],
      ),
    /Invalid or incomplete island/,
  );
  assert.throws(
    () =>
      createHierarchicalMapLayout(
        200,
        200,
        [],
        [
          {
            id: 'island',
            islandId: 'island',
            x: 100,
            y: 100,
            width: 20,
            height: 10,
          },
          {
            id: 'duplicate',
            islandId: 'island',
            x: 100,
            y: 100,
            width: 20,
            height: 10,
          },
        ],
        [{ id: 'island', x: 100, y: 100 }],
      ),
    /Duplicate label for island/,
  );
  for (const option of ['islandPadding', 'observationPadding', 'outerGap']) {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      assert.throws(
        () =>
          createHierarchicalMapLayout(
            200,
            200,
            [],
            [
              {
                id: 'island',
                islandId: 'island',
                x: 100,
                y: 100,
                width: 20,
                height: 10,
              },
            ],
            [{ id: 'island', x: 100, y: 100 }],
            { [option]: value },
          ),
        new RegExp(`${option} must be`),
      );
    }
  }
  assert.throws(
    () => createMinimumEnclosingCircle([{ x: 0, y: 0, radius: -1 }]),
    /finite, non-negative geometry/,
  );
  for (const invalidBody of [
    { x: Number.NaN, y: 0, radius: 1 },
    { x: 0, y: Number.POSITIVE_INFINITY, radius: 1 },
    { x: 0, y: 0, radius: Number.NEGATIVE_INFINITY },
  ]) {
    assert.throws(
      () => createMinimumEnclosingCircle([invalidBody]),
      /finite, non-negative geometry/,
    );
  }
});
