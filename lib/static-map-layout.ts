export type LayoutPoint = { x: number; y: number };

export type PaperLayoutAnchor = LayoutPoint & {
  id: string;
  radius: number;
  mobility?: number;
  anchorStrength?: number;
  maxDisplacement?: number;
};

export type LabelLayoutAnchor = LayoutPoint & {
  id: string;
  width: number;
  height: number;
  mobility?: number;
  anchorStrength?: number;
  maxDisplacement?: number;
};

export type StaticMapLayout = {
  papers: Map<string, LayoutPoint>;
  labels: Map<string, LayoutPoint>;
};

type PaperBody = PaperLayoutAnchor & {
  kind: 'paper';
  anchorX: number;
  anchorY: number;
  mobility: number;
  anchorStrength: number;
  maxDisplacement: number;
};

type LabelBody = LabelLayoutAnchor & {
  kind: 'label';
  anchorX: number;
  anchorY: number;
  mobility: number;
  anchorStrength: number;
  maxDisplacement: number;
};

type LayoutBody = PaperBody | LabelBody;

const ITERATIONS = 180;
const COLLISION_CLEANUP_ITERATIONS = 36;
const EDGE_GAP_PX = 5;
const MAX_STEP_PX = 5;

type LayoutSpacing = {
  paperGap: number;
  paperRepulsionRange: number;
  labelGap: number;
};

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

function paperBounds(body: PaperBody, width: number, height: number) {
  const margin = body.radius + EDGE_GAP_PX;
  return {
    minimumX: margin,
    maximumX: Math.max(margin, width - margin),
    minimumY: margin,
    maximumY: Math.max(margin, height - margin),
  };
}

function labelBounds(body: LabelBody, width: number, height: number) {
  const horizontalMargin = body.width / 2 + EDGE_GAP_PX;
  const verticalMargin = body.height / 2 + EDGE_GAP_PX;
  return {
    minimumX: horizontalMargin,
    maximumX: Math.max(horizontalMargin, width - horizontalMargin),
    minimumY: verticalMargin,
    maximumY: Math.max(verticalMargin, height - verticalMargin),
  };
}

function keepInsideCanvas(body: LayoutBody, width: number, height: number) {
  const bounds =
    body.kind === 'paper'
      ? paperBounds(body, width, height)
      : labelBounds(body, width, height);
  body.x = clamp(body.x, bounds.minimumX, bounds.maximumX);
  body.y = clamp(body.y, bounds.minimumY, bounds.maximumY);
}

function keepNearAnchor(body: LayoutBody) {
  const horizontalDistance = body.x - body.anchorX;
  const verticalDistance = body.y - body.anchorY;
  const distance = Math.hypot(horizontalDistance, verticalDistance);
  if (distance <= body.maxDisplacement || distance < 0.001) return;
  const scale = body.maxDisplacement / distance;
  body.x = body.anchorX + horizontalDistance * scale;
  body.y = body.anchorY + verticalDistance * scale;
}

function rectangleExitVector(
  horizontalDistance: number,
  verticalDistance: number,
  horizontalClearance: number,
  verticalClearance: number,
  firstId: string,
  secondId: string,
) {
  if (
    Math.abs(horizontalDistance) >= horizontalClearance ||
    Math.abs(verticalDistance) >= verticalClearance
  ) {
    return null;
  }

  let directionX = horizontalDistance;
  let directionY = verticalDistance;
  if (Math.hypot(directionX, directionY) < 0.001) {
    const direction = deterministicDirection(firstId, secondId);
    directionX = direction.x;
    directionY = direction.y;
  }

  const normalizedDistance = Math.max(
    Math.abs(directionX) / horizontalClearance,
    Math.abs(directionY) / verticalClearance,
  );
  const exitScale = 1 / Math.max(0.0001, normalizedDistance);
  return {
    x: directionX * (exitScale - 1),
    y: directionY * (exitScale - 1),
  };
}

function separatePapers(
  first: PaperBody,
  second: PaperBody,
  displacement: Map<string, LayoutPoint>,
  alpha: number,
  includeSoftRepulsion: boolean,
  spacing: LayoutSpacing,
) {
  let horizontalDistance = second.x - first.x;
  let verticalDistance = second.y - first.y;
  let distance = Math.hypot(horizontalDistance, verticalDistance);
  if (distance < 0.001) {
    const direction = deterministicDirection(first.id, second.id);
    horizontalDistance = direction.x;
    verticalDistance = direction.y;
    distance = 1;
  }

  const preferredDistance = first.radius + second.radius + spacing.paperGap;
  const repulsionLimit = preferredDistance + spacing.paperRepulsionRange;
  if (distance >= repulsionLimit) return;

  const collisionCorrection = Math.max(0, preferredDistance - distance) * 0.58;
  const softRepulsion = includeSoftRepulsion
    ? Math.max(0, repulsionLimit - Math.max(distance, preferredDistance)) *
      0.035
    : 0;
  const correction = (collisionCorrection + softRepulsion) * alpha;
  const unitX = horizontalDistance / distance;
  const unitY = verticalDistance / distance;
  const firstDisplacement = displacement.get(first.id) as LayoutPoint;
  const secondDisplacement = displacement.get(second.id) as LayoutPoint;
  const combinedMobility = Math.max(0.001, first.mobility + second.mobility);
  const firstShare = first.mobility / combinedMobility;
  const secondShare = second.mobility / combinedMobility;
  firstDisplacement.x -= unitX * correction * firstShare;
  firstDisplacement.y -= unitY * correction * firstShare;
  secondDisplacement.x += unitX * correction * secondShare;
  secondDisplacement.y += unitY * correction * secondShare;
}

function separatePaperAndLabel(
  paper: PaperBody,
  label: LabelBody,
  displacement: Map<string, LayoutPoint>,
  alpha: number,
  spacing: LayoutSpacing,
) {
  const horizontalDistance = paper.x - label.x;
  const verticalDistance = paper.y - label.y;
  const horizontalClearance = label.width / 2 + paper.radius + spacing.labelGap;
  const verticalClearance = label.height / 2 + paper.radius + spacing.labelGap;
  const exitVector = rectangleExitVector(
    horizontalDistance,
    verticalDistance,
    horizontalClearance,
    verticalClearance,
    label.id,
    paper.id,
  );
  if (!exitVector) return;

  const paperDisplacement = displacement.get(paper.id) as LayoutPoint;
  const labelDisplacement = displacement.get(label.id) as LayoutPoint;
  const combinedMobility = Math.max(0.001, paper.mobility + label.mobility);
  const paperShare = paper.mobility / combinedMobility;
  const labelShare = label.mobility / combinedMobility;
  const correctionScale = 0.64 * alpha;
  paperDisplacement.x += exitVector.x * correctionScale * paperShare;
  paperDisplacement.y += exitVector.y * correctionScale * paperShare;
  labelDisplacement.x -= exitVector.x * correctionScale * labelShare;
  labelDisplacement.y -= exitVector.y * correctionScale * labelShare;
}

function separateLabels(
  first: LabelBody,
  second: LabelBody,
  displacement: Map<string, LayoutPoint>,
  alpha: number,
  spacing: LayoutSpacing,
) {
  const horizontalDistance = second.x - first.x;
  const verticalDistance = second.y - first.y;
  const horizontalClearance =
    (first.width + second.width) / 2 + spacing.labelGap;
  const verticalClearance =
    (first.height + second.height) / 2 + spacing.labelGap;
  const exitVector = rectangleExitVector(
    horizontalDistance,
    verticalDistance,
    horizontalClearance,
    verticalClearance,
    first.id,
    second.id,
  );
  if (!exitVector) return;

  const firstDisplacement = displacement.get(first.id) as LayoutPoint;
  const secondDisplacement = displacement.get(second.id) as LayoutPoint;
  const combinedMobility = Math.max(0.001, first.mobility + second.mobility);
  const firstShare = first.mobility / combinedMobility;
  const secondShare = second.mobility / combinedMobility;
  const correctionScale = 0.68 * alpha;
  firstDisplacement.x -= exitVector.x * correctionScale * firstShare;
  firstDisplacement.y -= exitVector.y * correctionScale * firstShare;
  secondDisplacement.x += exitVector.x * correctionScale * secondShare;
  secondDisplacement.y += exitVector.y * correctionScale * secondShare;
}

function addCollisionDisplacements(
  papers: PaperBody[],
  labels: LabelBody[],
  displacement: Map<string, LayoutPoint>,
  alpha: number,
  includeSoftRepulsion: boolean,
  spacing: LayoutSpacing,
) {
  for (let firstIndex = 0; firstIndex < papers.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < papers.length;
      secondIndex += 1
    ) {
      separatePapers(
        papers[firstIndex],
        papers[secondIndex],
        displacement,
        alpha,
        includeSoftRepulsion,
        spacing,
      );
    }
  }

  for (const paper of papers) {
    for (const label of labels) {
      separatePaperAndLabel(paper, label, displacement, alpha, spacing);
    }
  }

  for (let firstIndex = 0; firstIndex < labels.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < labels.length;
      secondIndex += 1
    ) {
      separateLabels(
        labels[firstIndex],
        labels[secondIndex],
        displacement,
        alpha,
        spacing,
      );
    }
  }
}

/**
 * Runs a deterministic force-relaxation pass and returns only the final state.
 * The browser never animates the simulation, so the map remains visually still.
 */
export function createStaticMapLayout(
  width: number,
  height: number,
  paperAnchors: PaperLayoutAnchor[],
  labelAnchors: LabelLayoutAnchor[],
): StaticMapLayout {
  const papers: PaperBody[] = paperAnchors
    .map((paper) => ({
      ...paper,
      kind: 'paper' as const,
      anchorX: paper.x,
      anchorY: paper.y,
      mobility: paper.mobility ?? 1,
      anchorStrength: paper.anchorStrength ?? 0.042,
      maxDisplacement: paper.maxDisplacement ?? Number.POSITIVE_INFINITY,
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
  const labels: LabelBody[] = labelAnchors
    .map((label) => ({
      ...label,
      kind: 'label' as const,
      anchorX: label.x,
      anchorY: label.y,
      mobility: label.mobility ?? 0.22,
      anchorStrength: label.anchorStrength ?? 0.105,
      maxDisplacement: label.maxDisplacement ?? Number.POSITIVE_INFINITY,
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
  const bodies: LayoutBody[] = [...papers, ...labels];
  const spacingScale = clamp(width / 520, 0.72, 1);
  const spacing: LayoutSpacing = {
    paperGap: 9 * spacingScale,
    paperRepulsionRange: 14 * spacingScale,
    labelGap: 8 * spacingScale,
  };

  for (const body of bodies) {
    keepInsideCanvas(body, width, height);
    if (body.x !== body.anchorX || body.y !== body.anchorY) {
      body.anchorX = body.x;
      body.anchorY = body.y;
    }
  }

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const progress = iteration / Math.max(1, ITERATIONS - 1);
    const alpha = 0.88 - progress * 0.58;
    const displacement = new Map(
      bodies.map((body) => [body.id, { x: 0, y: 0 }]),
    );

    for (const body of bodies) {
      const movement = displacement.get(body.id) as LayoutPoint;
      movement.x += (body.anchorX - body.x) * body.anchorStrength;
      movement.y += (body.anchorY - body.y) * body.anchorStrength;
    }

    addCollisionDisplacements(
      papers,
      labels,
      displacement,
      alpha,
      true,
      spacing,
    );

    for (const body of bodies) {
      const movement = displacement.get(body.id) as LayoutPoint;
      body.x += clamp(movement.x, -MAX_STEP_PX, MAX_STEP_PX);
      body.y += clamp(movement.y, -MAX_STEP_PX, MAX_STEP_PX);
      keepNearAnchor(body);
      keepInsideCanvas(body, width, height);
    }
  }

  for (
    let iteration = 0;
    iteration < COLLISION_CLEANUP_ITERATIONS;
    iteration += 1
  ) {
    const displacement = new Map(
      bodies.map((body) => [body.id, { x: 0, y: 0 }]),
    );
    addCollisionDisplacements(papers, labels, displacement, 1, false, spacing);
    for (const body of bodies) {
      const movement = displacement.get(body.id) as LayoutPoint;
      body.x += clamp(movement.x, -MAX_STEP_PX, MAX_STEP_PX);
      body.y += clamp(movement.y, -MAX_STEP_PX, MAX_STEP_PX);
      keepNearAnchor(body);
      keepInsideCanvas(body, width, height);
    }
  }

  return {
    papers: new Map(
      papers.map((paper) => [paper.id, { x: paper.x, y: paper.y }]),
    ),
    labels: new Map(
      labels.map((label) => [label.id, { x: label.x, y: label.y }]),
    ),
  };
}
