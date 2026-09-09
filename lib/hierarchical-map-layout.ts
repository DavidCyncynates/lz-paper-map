export type LayoutPoint = { x: number; y: number };

export type HierarchicalPaperAnchor = LayoutPoint & {
  id: string;
  islandId: string;
  radius: number;
  stabilityRank: number;
};

export type HierarchicalLabelAnchor = LayoutPoint & {
  id: string;
  islandId: string;
  width: number;
  height: number;
};

export type HierarchicalIslandAnchor = LayoutPoint & {
  id: string;
  observation?: boolean;
};

export type LayoutCircle = LayoutPoint & { radius: number };

export type HierarchicalIslandLayout = LayoutCircle & {
  contentRadius: number;
  padding: number;
  semanticAnchor: LayoutPoint;
  observation: boolean;
  drawBoundary: boolean;
  anchorDrift: number;
};

export type HierarchicalLayoutDiagnostics = {
  converged: boolean;
  exactEnclosures: boolean;
  maxInnerOverlap: number;
  maxOuterOverlap: number;
  maxCanvasOverflow: number;
  maxObservationDrift: number;
};

export type HierarchicalMapLayout = {
  papers: Map<string, LayoutPoint>;
  labels: Map<string, LayoutPoint>;
  islands: Map<string, HierarchicalIslandLayout>;
  diagnostics: HierarchicalLayoutDiagnostics;
};

export type EnclosingBody = LayoutPoint & { radius: number };

export type HierarchicalLayoutOptions = {
  islandPadding?: number;
  observationPadding?: number;
  outerGap?: number;
};

type InternalPaper = HierarchicalPaperAnchor & {
  semanticX: number;
  semanticY: number;
};

type InternalLabel = HierarchicalLabelAnchor & {
  semanticX: number;
  semanticY: number;
};

type PackedIsland = LayoutCircle & {
  id: string;
  contentRadius: number;
  padding: number;
  anchorX: number;
  anchorY: number;
  observation: boolean;
  papers: InternalPaper[];
  label: InternalLabel;
};

const INNER_ITERATIONS = 260;
const INNER_CLEANUP_ITERATIONS = 720;
const OUTER_ITERATIONS = 300;
const OUTER_CLEANUP_ITERATIONS = 1200;
const INNER_INITIAL_SCALE = 0.85;
const INNER_CENTER_STRENGTH = 0.007;
const INNER_SEMANTIC_STRENGTH = 0.1;
const LABEL_CENTER_STRENGTH = 0.008;
const LABEL_SEMANTIC_STRENGTH = 0.12;
const OUTER_ANCHOR_STRENGTH = 0.038;
const OBSERVATION_ANCHOR_STRENGTH = 0.1;
const OBSERVATION_MOBILITY = 0.25;
const OUTER_COHESION_STRENGTH = 0.006;
const OUTER_CENTER_STRENGTH = 0.0018;
const MAX_INNER_STEP = 4.5;
const MAX_OUTER_STEP = 8;
const PAPER_GAP = 8;
const PAPER_REPULSION_RANGE = 16;
const LABEL_GAP = 9;
const OUTER_REPULSION_RANGE = 24;
const CANVAS_MARGIN = 14;
const DEFAULT_ISLAND_PADDING = 24;
const DEFAULT_OBSERVATION_PADDING = 12;
const DEFAULT_OUTER_GAP = 16;
const LAYOUT_EPSILON = 1e-6;
const LAYOUT_TOLERANCE = 0.02;
const MEC_EPSILON = 1e-10;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function deterministicDirection(firstId: string, secondId: string) {
  const key = `${firstId}:${secondId}`;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) / 4294967295) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function compareIds(first: { id: string }, second: { id: string }) {
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

function assertUniqueIds<T extends { id: string }>(
  values: readonly T[],
  description: string,
) {
  const identifiers = new Set<string>();
  for (const value of values) {
    if (!value.id || identifiers.has(value.id)) {
      throw new Error(`Duplicate or empty ${description} ID: ${value.id}`);
    }
    identifiers.add(value.id);
  }
}

function assertFiniteGeometry(
  paperAnchors: readonly HierarchicalPaperAnchor[],
  labelAnchors: readonly HierarchicalLabelAnchor[],
  islandAnchors: readonly HierarchicalIslandAnchor[],
) {
  assertUniqueIds(paperAnchors, 'paper');
  assertUniqueIds(labelAnchors, 'label');
  assertUniqueIds(islandAnchors, 'island');
  const islandIds = new Set(islandAnchors.map((island) => island.id));
  const labelIslandIds = new Set<string>();
  const paperStabilityRanks = new Set<number>();
  for (const paper of paperAnchors) {
    if (
      !Number.isFinite(paper.x) ||
      !Number.isFinite(paper.y) ||
      !Number.isFinite(paper.radius) ||
      paper.radius < 0 ||
      !Number.isSafeInteger(paper.stabilityRank) ||
      paper.stabilityRank < 0 ||
      paperStabilityRanks.has(paper.stabilityRank) ||
      !islandIds.has(paper.islandId)
    ) {
      throw new Error(`Invalid geometry for paper ${paper.id}.`);
    }
    paperStabilityRanks.add(paper.stabilityRank);
  }
  for (const label of labelAnchors) {
    if (labelIslandIds.has(label.islandId)) {
      throw new Error(`Duplicate label for island ${label.islandId}.`);
    }
    if (
      label.id !== label.islandId ||
      !Number.isFinite(label.x) ||
      !Number.isFinite(label.y) ||
      !Number.isFinite(label.width) ||
      !Number.isFinite(label.height) ||
      label.width < 0 ||
      label.height < 0 ||
      !islandIds.has(label.islandId)
    ) {
      throw new Error(`Invalid geometry for label ${label.id}.`);
    }
    labelIslandIds.add(label.islandId);
  }
  for (const island of islandAnchors) {
    if (
      !Number.isFinite(island.x) ||
      !Number.isFinite(island.y) ||
      !labelIslandIds.has(island.id)
    ) {
      throw new Error(`Invalid or incomplete island ${island.id}.`);
    }
  }
}

function comparePaperStability(first: InternalPaper, second: InternalPaper) {
  return (
    first.stabilityRank - second.stabilityRank || compareIds(first, second)
  );
}

function validateNonnegativeOption(
  name: keyof HierarchicalLayoutOptions,
  value: number | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative number.`);
  }
  return value;
}

function containsBody(circle: LayoutCircle, body: EnclosingBody) {
  const tolerance =
    MEC_EPSILON *
    32 *
    Math.max(
      1,
      circle.radius,
      body.radius,
      Math.abs(circle.x),
      Math.abs(circle.y),
    );
  return (
    Math.hypot(circle.x - body.x, circle.y - body.y) + body.radius <=
    circle.radius + tolerance
  );
}

function containsEveryBody(
  circle: LayoutCircle,
  bodies: readonly EnclosingBody[],
) {
  return bodies.every((body) => containsBody(circle, body));
}

function circleFromPair(
  first: EnclosingBody,
  second: EnclosingBody,
): LayoutCircle {
  const horizontalDistance = second.x - first.x;
  const verticalDistance = second.y - first.y;
  const distance = Math.hypot(horizontalDistance, verticalDistance);
  if (distance < MEC_EPSILON) {
    return first.radius >= second.radius
      ? { x: first.x, y: first.y, radius: first.radius }
      : { x: second.x, y: second.y, radius: second.radius };
  }
  if (first.radius >= distance + second.radius) {
    return { x: first.x, y: first.y, radius: first.radius };
  }
  if (second.radius >= distance + first.radius) {
    return { x: second.x, y: second.y, radius: second.radius };
  }

  const radius = (distance + first.radius + second.radius) / 2;
  const distanceFromFirst = radius - first.radius;
  return {
    x: first.x + (horizontalDistance / distance) * distanceFromFirst,
    y: first.y + (verticalDistance / distance) * distanceFromFirst,
    radius,
  };
}

function solveQuadratic(quadratic: number, linear: number, constant: number) {
  const coefficientScale = Math.max(
    1,
    Math.abs(quadratic),
    Math.abs(linear),
    Math.abs(constant),
  );
  if (Math.abs(quadratic) <= MEC_EPSILON * coefficientScale) {
    return Math.abs(linear) <= MEC_EPSILON * coefficientScale
      ? []
      : [-constant / linear];
  }
  const discriminant = linear * linear - 4 * quadratic * constant;
  const discriminantScale = Math.max(
    1,
    linear * linear,
    Math.abs(4 * quadratic * constant),
  );
  if (discriminant < -MEC_EPSILON * discriminantScale) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  if (root <= MEC_EPSILON * Math.sqrt(discriminantScale)) {
    return [-linear / (2 * quadratic)];
  }
  const stableNumerator = -0.5 * (linear + Math.sign(linear || 1) * root);
  const firstRoot = stableNumerator / quadratic;
  const secondRoot = constant / stableNumerator;
  return [firstRoot, secondRoot];
}

function circlesFromTriple(
  first: EnclosingBody,
  second: EnclosingBody,
  third: EnclosingBody,
) {
  const firstRowX = 2 * (second.x - first.x);
  const firstRowY = 2 * (second.y - first.y);
  const secondRowX = 2 * (third.x - first.x);
  const secondRowY = 2 * (third.y - first.y);
  const determinant = firstRowX * secondRowY - firstRowY * secondRowX;
  const determinantScale = Math.max(
    1,
    Math.abs(firstRowX * secondRowY),
    Math.abs(firstRowY * secondRowX),
  );
  if (Math.abs(determinant) <= MEC_EPSILON * determinantScale) return [];

  const firstConstant =
    second.x * second.x +
    second.y * second.y -
    first.x * first.x -
    first.y * first.y -
    (second.radius * second.radius - first.radius * first.radius);
  const secondConstant =
    third.x * third.x +
    third.y * third.y -
    first.x * first.x -
    first.y * first.y -
    (third.radius * third.radius - first.radius * first.radius);
  const firstRadiusTerm = 2 * (second.radius - first.radius);
  const secondRadiusTerm = 2 * (third.radius - first.radius);

  const centerConstantX =
    (firstConstant * secondRowY - firstRowY * secondConstant) / determinant;
  const centerConstantY =
    (firstRowX * secondConstant - firstConstant * secondRowX) / determinant;
  const centerRadiusX =
    (firstRadiusTerm * secondRowY - firstRowY * secondRadiusTerm) / determinant;
  const centerRadiusY =
    (firstRowX * secondRadiusTerm - firstRadiusTerm * secondRowX) / determinant;

  const offsetX = centerConstantX - first.x;
  const offsetY = centerConstantY - first.y;
  const quadratic =
    centerRadiusX * centerRadiusX + centerRadiusY * centerRadiusY - 1;
  const linear =
    2 * (offsetX * centerRadiusX + offsetY * centerRadiusY + first.radius);
  const constant =
    offsetX * offsetX + offsetY * offsetY - first.radius * first.radius;
  const minimumRadius = Math.max(first.radius, second.radius, third.radius);

  return solveQuadratic(quadratic, linear, constant).flatMap((radius) => {
    if (
      !Number.isFinite(radius) ||
      radius < minimumRadius - MEC_EPSILON * Math.max(1, minimumRadius)
    ) {
      return [];
    }
    const circle = {
      x: centerConstantX + centerRadiusX * radius,
      y: centerConstantY + centerRadiusY * radius,
      radius,
    };
    return containsEveryBody(circle, [first, second, third]) ? [circle] : [];
  });
}

function isBetterCircle(candidate: LayoutCircle, current: LayoutCircle | null) {
  if (!current) return true;
  if (candidate.radius < current.radius - MEC_EPSILON) return true;
  if (Math.abs(candidate.radius - current.radius) > MEC_EPSILON) return false;
  if (candidate.x < current.x - MEC_EPSILON) return true;
  if (Math.abs(candidate.x - current.x) > MEC_EPSILON) return false;
  return candidate.y < current.y;
}

function findMinimumEnclosingCircle(
  bodies: readonly EnclosingBody[],
): LayoutCircle {
  let best: LayoutCircle | null = null;
  const consider = (candidate: LayoutCircle) => {
    if (
      Number.isFinite(candidate.x) &&
      Number.isFinite(candidate.y) &&
      Number.isFinite(candidate.radius) &&
      candidate.radius >= 0 &&
      containsEveryBody(candidate, bodies) &&
      isBetterCircle(candidate, best)
    ) {
      best = candidate;
    }
  };

  for (const body of bodies) {
    consider({ x: body.x, y: body.y, radius: body.radius });
  }
  for (let firstIndex = 0; firstIndex < bodies.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < bodies.length;
      secondIndex += 1
    ) {
      consider(circleFromPair(bodies[firstIndex], bodies[secondIndex]));
    }
  }
  for (let firstIndex = 0; firstIndex < bodies.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < bodies.length;
      secondIndex += 1
    ) {
      for (
        let thirdIndex = secondIndex + 1;
        thirdIndex < bodies.length;
        thirdIndex += 1
      ) {
        for (const circle of circlesFromTriple(
          bodies[firstIndex],
          bodies[secondIndex],
          bodies[thirdIndex],
        )) {
          consider(circle);
        }
      }
    }
  }

  if (!best) {
    throw new Error('Unable to compute an exact minimum enclosing circle.');
  }
  return best;
}

/**
 * Finds the deterministic minimum circle enclosing a set of discs. Point-like
 * bodies, including label corners, are represented by a zero radius.
 */
export function createMinimumEnclosingCircle(
  inputBodies: readonly EnclosingBody[],
): LayoutCircle | null {
  if (!inputBodies.length) return null;
  const bodies = inputBodies
    .map((body) => {
      if (
        !Number.isFinite(body.x) ||
        !Number.isFinite(body.y) ||
        !Number.isFinite(body.radius) ||
        body.radius < 0
      ) {
        throw new Error(
          'Enclosing bodies must have finite, non-negative geometry.',
        );
      }
      return { ...body };
    })
    .sort(
      (first, second) =>
        first.x - second.x ||
        first.y - second.y ||
        first.radius - second.radius,
    );
  const origin = { x: bodies[0].x, y: bodies[0].y };
  const scale = Math.max(
    ...bodies.map((body) =>
      Math.max(
        Math.abs(body.x - origin.x),
        Math.abs(body.y - origin.y),
        body.radius,
      ),
    ),
  );
  if (scale === 0) {
    return { x: origin.x, y: origin.y, radius: 0 };
  }
  const normalizedBodies = bodies.map((body) => ({
    x: (body.x - origin.x) / scale,
    y: (body.y - origin.y) / scale,
    radius: body.radius / scale,
  }));
  const normalizedCircle = findMinimumEnclosingCircle(normalizedBodies);
  return {
    x: origin.x + normalizedCircle.x * scale,
    y: origin.y + normalizedCircle.y * scale,
    radius: normalizedCircle.radius * scale,
  };
}

function circleRectangleExitVector(
  horizontalDistance: number,
  verticalDistance: number,
  halfWidth: number,
  halfHeight: number,
  clearance: number,
  firstId: string,
  secondId: string,
) {
  const closestX = clamp(horizontalDistance, -halfWidth, halfWidth);
  const closestY = clamp(verticalDistance, -halfHeight, halfHeight);
  const outsideX = horizontalDistance - closestX;
  const outsideY = verticalDistance - closestY;
  const outsideDistance = Math.hypot(outsideX, outsideY);
  if (outsideDistance >= clearance) return null;
  if (outsideDistance > LAYOUT_EPSILON) {
    const correction = clearance - outsideDistance;
    return {
      x: (outsideX / outsideDistance) * correction,
      y: (outsideY / outsideDistance) * correction,
    };
  }

  const candidates = [
    { x: -halfWidth - clearance - horizontalDistance, y: 0 },
    { x: halfWidth + clearance - horizontalDistance, y: 0 },
    { x: 0, y: -halfHeight - clearance - verticalDistance },
    { x: 0, y: halfHeight + clearance - verticalDistance },
  ];
  const direction = deterministicDirection(firstId, secondId);
  candidates.sort((first, second) => {
    const distanceDifference =
      Math.hypot(first.x, first.y) - Math.hypot(second.x, second.y);
    if (Math.abs(distanceDifference) > LAYOUT_EPSILON) {
      return distanceDifference;
    }
    return (
      second.x * direction.x +
      second.y * direction.y -
      (first.x * direction.x + first.y * direction.y)
    );
  });
  return candidates[0];
}

function addInnerCollisions(
  papers: InternalPaper[],
  label: InternalLabel,
  paperMovement: Map<string, LayoutPoint>,
  labelMovement: LayoutPoint,
  alpha: number,
  includeSoftRepulsion: boolean,
  spacingScale: number,
) {
  for (let firstIndex = 0; firstIndex < papers.length; firstIndex += 1) {
    const first = papers[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < papers.length;
      secondIndex += 1
    ) {
      const second = papers[secondIndex];
      let horizontalDistance = second.x - first.x;
      let verticalDistance = second.y - first.y;
      let distance = Math.hypot(horizontalDistance, verticalDistance);
      if (distance < LAYOUT_EPSILON) {
        const direction = deterministicDirection(first.id, second.id);
        horizontalDistance = direction.x;
        verticalDistance = direction.y;
        distance = 1;
      }
      const preferredDistance =
        first.radius + second.radius + PAPER_GAP * spacingScale;
      const repulsionLimit =
        preferredDistance + PAPER_REPULSION_RANGE * spacingScale;
      if (distance >= repulsionLimit) continue;
      const collisionCorrection =
        Math.max(0, preferredDistance - distance) * 0.68;
      const softRepulsion = includeSoftRepulsion
        ? Math.max(0, repulsionLimit - Math.max(distance, preferredDistance)) *
          0.035
        : 0;
      const correction = (collisionCorrection + softRepulsion) * alpha;
      const unitX = horizontalDistance / distance;
      const unitY = verticalDistance / distance;
      const firstMovement = paperMovement.get(first.id) as LayoutPoint;
      const secondMovement = paperMovement.get(second.id) as LayoutPoint;
      // Catalog order is append-only. Giving the later-added paper most of a
      // collision correction keeps an established island stable, including
      // when the addition is a backfilled paper with an older arXiv ID.
      const olderShare = 0.04;
      const newerShare = 1 - olderShare;
      firstMovement.x -= unitX * correction * olderShare;
      firstMovement.y -= unitY * correction * olderShare;
      secondMovement.x += unitX * correction * newerShare;
      secondMovement.y += unitY * correction * newerShare;
    }
  }

  for (const paper of papers) {
    const horizontalDistance = paper.x - label.x;
    const verticalDistance = paper.y - label.y;
    const exitVector = circleRectangleExitVector(
      horizontalDistance,
      verticalDistance,
      label.width / 2,
      label.height / 2,
      paper.radius + LABEL_GAP * spacingScale,
      `label:${label.id}`,
      paper.id,
    );
    if (!exitVector) continue;
    const movement = paperMovement.get(paper.id) as LayoutPoint;
    const correctionScale = 0.74 * alpha;
    movement.x += exitVector.x * correctionScale * 0.82;
    movement.y += exitVector.y * correctionScale * 0.82;
    labelMovement.x -= exitVector.x * correctionScale * 0.18;
    labelMovement.y -= exitVector.y * correctionScale * 0.18;
  }
}

function relaxIslandContents(
  island: HierarchicalIslandAnchor,
  paperAnchors: readonly HierarchicalPaperAnchor[],
  labelAnchor: HierarchicalLabelAnchor,
  spacingScale: number,
  padding: number,
): PackedIsland {
  const papers: InternalPaper[] = paperAnchors
    .map((paper) => {
      const semanticX = (paper.x - island.x) * INNER_INITIAL_SCALE;
      const semanticY = (paper.y - island.y) * INNER_INITIAL_SCALE;
      return { ...paper, x: semanticX, y: semanticY, semanticX, semanticY };
    })
    .sort(comparePaperStability);
  const labelSemanticX = labelAnchor.x - island.x;
  const labelSemanticY = labelAnchor.y - island.y;
  const label: InternalLabel = {
    ...labelAnchor,
    x: labelSemanticX,
    y: labelSemanticY,
    semanticX: labelSemanticX,
    semanticY: labelSemanticY,
  };

  for (let iteration = 0; iteration < INNER_ITERATIONS; iteration += 1) {
    const progress = iteration / Math.max(1, INNER_ITERATIONS - 1);
    const alpha = 0.92 - progress * 0.58;
    const paperMovement = new Map(
      papers.map((paper) => [paper.id, { x: 0, y: 0 }]),
    );
    const labelMovement = { x: 0, y: 0 };
    for (const paper of papers) {
      const movement = paperMovement.get(paper.id) as LayoutPoint;
      movement.x += -paper.x * INNER_CENTER_STRENGTH;
      movement.y += -paper.y * INNER_CENTER_STRENGTH;
      movement.x += (paper.semanticX - paper.x) * INNER_SEMANTIC_STRENGTH;
      movement.y += (paper.semanticY - paper.y) * INNER_SEMANTIC_STRENGTH;
    }
    labelMovement.x += -label.x * LABEL_CENTER_STRENGTH;
    labelMovement.y += -label.y * LABEL_CENTER_STRENGTH;
    labelMovement.x += (label.semanticX - label.x) * LABEL_SEMANTIC_STRENGTH;
    labelMovement.y += (label.semanticY - label.y) * LABEL_SEMANTIC_STRENGTH;
    addInnerCollisions(
      papers,
      label,
      paperMovement,
      labelMovement,
      alpha,
      true,
      spacingScale,
    );
    for (const paper of papers) {
      const movement = paperMovement.get(paper.id) as LayoutPoint;
      paper.x += clamp(movement.x, -MAX_INNER_STEP, MAX_INNER_STEP);
      paper.y += clamp(movement.y, -MAX_INNER_STEP, MAX_INNER_STEP);
    }
    label.x += clamp(labelMovement.x, -MAX_INNER_STEP, MAX_INNER_STEP);
    label.y += clamp(labelMovement.y, -MAX_INNER_STEP, MAX_INNER_STEP);
  }

  for (
    let iteration = 0;
    iteration < INNER_CLEANUP_ITERATIONS;
    iteration += 1
  ) {
    const paperMovement = new Map(
      papers.map((paper) => [paper.id, { x: 0, y: 0 }]),
    );
    const labelMovement = { x: 0, y: 0 };
    addInnerCollisions(
      papers,
      label,
      paperMovement,
      labelMovement,
      1,
      false,
      spacingScale,
    );
    for (const paper of papers) {
      const movement = paperMovement.get(paper.id) as LayoutPoint;
      paper.x += clamp(movement.x, -MAX_INNER_STEP, MAX_INNER_STEP);
      paper.y += clamp(movement.y, -MAX_INNER_STEP, MAX_INNER_STEP);
    }
    label.x += clamp(labelMovement.x, -MAX_INNER_STEP, MAX_INNER_STEP);
    label.y += clamp(labelMovement.y, -MAX_INNER_STEP, MAX_INNER_STEP);
  }

  const enclosingBodies: EnclosingBody[] = papers.map((paper) => ({
    x: paper.x,
    y: paper.y,
    radius: paper.radius,
  }));
  const halfLabelWidth = label.width / 2;
  const halfLabelHeight = label.height / 2;
  enclosingBodies.push(
    {
      x: label.x - halfLabelWidth,
      y: label.y - halfLabelHeight,
      radius: 0,
    },
    {
      x: label.x + halfLabelWidth,
      y: label.y - halfLabelHeight,
      radius: 0,
    },
    {
      x: label.x + halfLabelWidth,
      y: label.y + halfLabelHeight,
      radius: 0,
    },
    {
      x: label.x - halfLabelWidth,
      y: label.y + halfLabelHeight,
      radius: 0,
    },
  );
  const enclosure = createMinimumEnclosingCircle(enclosingBodies);
  if (!enclosure) {
    throw new Error(`Island ${island.id} has no geometry to enclose.`);
  }
  for (const paper of papers) {
    paper.x -= enclosure.x;
    paper.y -= enclosure.y;
    paper.semanticX -= enclosure.x;
    paper.semanticY -= enclosure.y;
  }
  label.x -= enclosure.x;
  label.y -= enclosure.y;
  label.semanticX -= enclosure.x;
  label.semanticY -= enclosure.y;

  return {
    id: island.id,
    x: island.x + enclosure.x,
    y: island.y + enclosure.y,
    radius: enclosure.radius + padding,
    contentRadius: enclosure.radius,
    padding,
    anchorX: island.x + enclosure.x,
    anchorY: island.y + enclosure.y,
    observation: island.observation ?? false,
    papers,
    label,
  };
}

function keepIslandInsideCanvas(
  island: PackedIsland,
  width: number,
  height: number,
) {
  const horizontalMargin = Math.min(width / 2, island.radius + CANVAS_MARGIN);
  const verticalMargin = Math.min(height / 2, island.radius + CANVAS_MARGIN);
  island.x = clamp(island.x, horizontalMargin, width - horizontalMargin);
  island.y = clamp(island.y, verticalMargin, height - verticalMargin);
}

function addOuterRepulsion(
  islands: PackedIsland[],
  movement: Map<string, LayoutPoint>,
  alpha: number,
  includeSoftRepulsion: boolean,
  outerGap: number,
  spacingScale: number,
) {
  for (let firstIndex = 0; firstIndex < islands.length; firstIndex += 1) {
    const first = islands[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < islands.length;
      secondIndex += 1
    ) {
      const second = islands[secondIndex];
      let horizontalDistance = second.x - first.x;
      let verticalDistance = second.y - first.y;
      let distance = Math.hypot(horizontalDistance, verticalDistance);
      if (distance < LAYOUT_EPSILON) {
        const direction = deterministicDirection(first.id, second.id);
        horizontalDistance = direction.x;
        verticalDistance = direction.y;
        distance = 1;
      }
      const preferredDistance =
        first.radius + second.radius + outerGap * spacingScale;
      const repulsionLimit =
        preferredDistance + OUTER_REPULSION_RANGE * spacingScale;
      if (distance >= repulsionLimit) continue;
      const collisionCorrection =
        Math.max(0, preferredDistance - distance) * 0.72;
      const softRepulsion = includeSoftRepulsion
        ? Math.max(0, repulsionLimit - Math.max(distance, preferredDistance)) *
          0.025
        : 0;
      const correction = (collisionCorrection + softRepulsion) * alpha;
      const unitX = horizontalDistance / distance;
      const unitY = verticalDistance / distance;
      const firstMovement = movement.get(first.id) as LayoutPoint;
      const secondMovement = movement.get(second.id) as LayoutPoint;
      const firstMobility = first.observation ? OBSERVATION_MOBILITY : 1;
      const secondMobility = second.observation ? OBSERVATION_MOBILITY : 1;
      const combinedMobility = firstMobility + secondMobility;
      firstMovement.x -=
        unitX * correction * (firstMobility / combinedMobility);
      firstMovement.y -=
        unitY * correction * (firstMobility / combinedMobility);
      secondMovement.x +=
        unitX * correction * (secondMobility / combinedMobility);
      secondMovement.y +=
        unitY * correction * (secondMobility / combinedMobility);
    }
  }
}

function packIslands(
  islands: PackedIsland[],
  width: number,
  height: number,
  outerGap: number,
  spacingScale: number,
) {
  const ordered = [...islands].sort(compareIds);
  for (const island of ordered) keepIslandInsideCanvas(island, width, height);

  for (let iteration = 0; iteration < OUTER_ITERATIONS; iteration += 1) {
    const progress = iteration / Math.max(1, OUTER_ITERATIONS - 1);
    const alpha = 0.94 - progress * 0.59;
    const movement = new Map(
      ordered.map((island) => [island.id, { x: 0, y: 0 }]),
    );
    const centroid = ordered.reduce(
      (sum, island) => ({ x: sum.x + island.x, y: sum.y + island.y }),
      { x: 0, y: 0 },
    );
    centroid.x /= Math.max(1, ordered.length);
    centroid.y /= Math.max(1, ordered.length);

    for (const island of ordered) {
      const islandMovement = movement.get(island.id) as LayoutPoint;
      const anchorStrength = island.observation
        ? OBSERVATION_ANCHOR_STRENGTH
        : OUTER_ANCHOR_STRENGTH;
      islandMovement.x += (island.anchorX - island.x) * anchorStrength;
      islandMovement.y += (island.anchorY - island.y) * anchorStrength;
      islandMovement.x += (centroid.x - island.x) * OUTER_COHESION_STRENGTH;
      islandMovement.y += (centroid.y - island.y) * OUTER_COHESION_STRENGTH;
      islandMovement.x += (width / 2 - island.x) * OUTER_CENTER_STRENGTH;
      islandMovement.y += (height / 2 - island.y) * OUTER_CENTER_STRENGTH;
    }
    addOuterRepulsion(ordered, movement, alpha, true, outerGap, spacingScale);
    for (const island of ordered) {
      const islandMovement = movement.get(island.id) as LayoutPoint;
      island.x += clamp(islandMovement.x, -MAX_OUTER_STEP, MAX_OUTER_STEP);
      island.y += clamp(islandMovement.y, -MAX_OUTER_STEP, MAX_OUTER_STEP);
      keepIslandInsideCanvas(island, width, height);
    }
  }

  for (
    let iteration = 0;
    iteration < OUTER_CLEANUP_ITERATIONS;
    iteration += 1
  ) {
    const movement = new Map(
      ordered.map((island) => [island.id, { x: 0, y: 0 }]),
    );
    addOuterRepulsion(ordered, movement, 1, false, outerGap, spacingScale);
    for (const island of ordered) {
      const islandMovement = movement.get(island.id) as LayoutPoint;
      island.x += clamp(islandMovement.x, -MAX_OUTER_STEP, MAX_OUTER_STEP);
      island.y += clamp(islandMovement.y, -MAX_OUTER_STEP, MAX_OUTER_STEP);
      keepIslandInsideCanvas(island, width, height);
    }
  }
  return ordered;
}

function measureInnerOverlap(island: PackedIsland, spacingScale: number) {
  let maximumOverlap = 0;
  for (let firstIndex = 0; firstIndex < island.papers.length; firstIndex += 1) {
    const first = island.papers[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < island.papers.length;
      secondIndex += 1
    ) {
      const second = island.papers[secondIndex];
      maximumOverlap = Math.max(
        maximumOverlap,
        first.radius +
          second.radius +
          PAPER_GAP * spacingScale -
          Math.hypot(first.x - second.x, first.y - second.y),
      );
    }
    const horizontalDistance = Math.max(
      Math.abs(first.x - island.label.x) - island.label.width / 2,
      0,
    );
    const verticalDistance = Math.max(
      Math.abs(first.y - island.label.y) - island.label.height / 2,
      0,
    );
    maximumOverlap = Math.max(
      maximumOverlap,
      first.radius +
        LABEL_GAP * spacingScale -
        Math.hypot(horizontalDistance, verticalDistance),
    );
  }
  return Math.max(0, maximumOverlap);
}

function measureOuterDiagnostics(
  islands: readonly PackedIsland[],
  width: number,
  height: number,
  outerGap: number,
  spacingScale: number,
) {
  let maxOuterOverlap = 0;
  let maxCanvasOverflow = 0;
  for (let firstIndex = 0; firstIndex < islands.length; firstIndex += 1) {
    const first = islands[firstIndex];
    maxCanvasOverflow = Math.max(
      maxCanvasOverflow,
      CANVAS_MARGIN - (first.x - first.radius),
      CANVAS_MARGIN - (first.y - first.radius),
      first.x + first.radius + CANVAS_MARGIN - width,
      first.y + first.radius + CANVAS_MARGIN - height,
    );
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < islands.length;
      secondIndex += 1
    ) {
      const second = islands[secondIndex];
      maxOuterOverlap = Math.max(
        maxOuterOverlap,
        first.radius +
          second.radius +
          outerGap * spacingScale -
          Math.hypot(first.x - second.x, first.y - second.y),
      );
    }
  }
  return {
    maxOuterOverlap: Math.max(0, maxOuterOverlap),
    maxCanvasOverflow: Math.max(0, maxCanvasOverflow),
  };
}

/**
 * Builds each island independently, wraps it in a padded minimum circle, then
 * packs those rigid circles together. The observation participates in packing
 * but its circle can remain visually hidden by the renderer.
 */
export function createHierarchicalMapLayout(
  width: number,
  height: number,
  paperAnchors: readonly HierarchicalPaperAnchor[],
  labelAnchors: readonly HierarchicalLabelAnchor[],
  islandAnchors: readonly HierarchicalIslandAnchor[],
  options: HierarchicalLayoutOptions = {},
): HierarchicalMapLayout {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('Map dimensions must be finite and positive.');
  }
  assertFiniteGeometry(paperAnchors, labelAnchors, islandAnchors);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const spacingScale = clamp(safeWidth / 1160, 0.82, 1.18);
  const islandPadding = validateNonnegativeOption(
    'islandPadding',
    options.islandPadding,
    DEFAULT_ISLAND_PADDING,
  );
  const observationPadding = validateNonnegativeOption(
    'observationPadding',
    options.observationPadding,
    DEFAULT_OBSERVATION_PADDING,
  );
  const outerGap = validateNonnegativeOption(
    'outerGap',
    options.outerGap,
    DEFAULT_OUTER_GAP,
  );
  const labelsByIsland = new Map(
    labelAnchors.map((label) => [label.islandId, label]),
  );
  const papersByIsland = new Map<string, HierarchicalPaperAnchor[]>();
  for (const paper of paperAnchors) {
    const papers = papersByIsland.get(paper.islandId) ?? [];
    papers.push(paper);
    papersByIsland.set(paper.islandId, papers);
  }

  const assembled = [...islandAnchors].sort(compareIds).flatMap((island) => {
    const label = labelsByIsland.get(island.id);
    if (!label) return [];
    return [
      relaxIslandContents(
        island,
        papersByIsland.get(island.id) ?? [],
        label,
        spacingScale,
        island.observation ? observationPadding : islandPadding,
      ),
    ];
  });
  const packed = packIslands(
    assembled,
    safeWidth,
    safeHeight,
    outerGap,
    spacingScale,
  );
  const papers = new Map<string, LayoutPoint>();
  const labels = new Map<string, LayoutPoint>();
  const islands = new Map<string, HierarchicalIslandLayout>();
  for (const island of packed) {
    islands.set(island.id, {
      x: island.x,
      y: island.y,
      radius: island.radius,
      contentRadius: island.contentRadius,
      padding: island.padding,
      semanticAnchor: { x: island.anchorX, y: island.anchorY },
      observation: island.observation,
      drawBoundary: !island.observation,
      anchorDrift: Math.hypot(
        island.x - island.anchorX,
        island.y - island.anchorY,
      ),
    });
    labels.set(island.label.id, {
      x: island.x + island.label.x,
      y: island.y + island.label.y,
    });
    for (const paper of island.papers) {
      papers.set(paper.id, {
        x: island.x + paper.x,
        y: island.y + paper.y,
      });
    }
  }
  const maxInnerOverlap = Math.max(
    0,
    ...packed.map((island) => measureInnerOverlap(island, spacingScale)),
  );
  const { maxOuterOverlap, maxCanvasOverflow } = measureOuterDiagnostics(
    packed,
    safeWidth,
    safeHeight,
    outerGap,
    spacingScale,
  );
  const maxObservationDrift = Math.max(
    0,
    ...packed
      .filter((island) => island.observation)
      .map((island) =>
        Math.hypot(island.x - island.anchorX, island.y - island.anchorY),
      ),
  );
  return {
    papers,
    labels,
    islands,
    diagnostics: {
      converged:
        maxInnerOverlap <= LAYOUT_TOLERANCE &&
        maxOuterOverlap <= LAYOUT_TOLERANCE &&
        maxCanvasOverflow <= LAYOUT_TOLERANCE,
      exactEnclosures: true,
      maxInnerOverlap,
      maxOuterOverlap,
      maxCanvasOverflow,
      maxObservationDrift,
    },
  };
}
