import { citationDiameter } from './paper-citation-size.ts';

export type MapLayoutMode = 'uniform' | 'citations';

export type MapLayoutPaper = {
  role: string;
};

export type MapLayoutIsland = {
  label: string;
  kicker: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const MAP_LAYOUT_SCHEMA_VERSION = 1;
export const MAP_LAYOUT_SOLVER_VERSION = 6;
export const MAP_WORLD_WIDTH = 1160;
export const MAP_WORLD_HEIGHT = 780;
export const FOLLOW_UP_DIAMETER_PX = 16;
export const OBSERVATION_DIAMETER_PX = 28;
export const ISLAND_PADDING_PX = 24;
export const OBSERVATION_PACKING_PADDING_PX = 12;
export const ISLAND_GAP_PX = 16;
export const NODE_HALO_PX = 5;
export const NODE_ACTIVE_SCALE = 1.12;

export function mapPaperDiameter(
  paper: MapLayoutPaper,
  mode: MapLayoutMode,
  incomingCitationCount: number,
) {
  if (mode === 'citations') return citationDiameter(incomingCitationCount);
  return paper.role === 'observation'
    ? OBSERVATION_DIAMETER_PX
    : FOLLOW_UP_DIAMETER_PX;
}

export function mapPaperCollisionRadius(
  paper: MapLayoutPaper,
  mode: MapLayoutMode,
  incomingCitationCount: number,
) {
  return (
    (mapPaperDiameter(paper, mode, incomingCitationCount) / 2 + NODE_HALO_PX) *
    NODE_ACTIVE_SCALE
  );
}

const LABEL_MINIMUM_WIDTH_PX = 92;
const LABEL_HORIZONTAL_PADDING_PX = 8;
const LABEL_SINGLE_LINE_HEIGHT_PX = 34;
export const ISLAND_LABEL_TITLE_FONT_SIZE_PX = 12.5;
export const ISLAND_LABEL_TITLE_LINE_HEIGHT_PX = 16;
export const ISLAND_LABEL_KICKER_FONT_SIZE_PX = 7;
export const ISLAND_LABEL_KICKER_LINE_HEIGHT_PX = 8;
const LABEL_TITLE_CHARACTER_WIDTH_PX = 7.4;
const LABEL_KICKER_CHARACTER_WIDTH_PX = 5.5;
const LABEL_MAX_SINGLE_LINE_TITLE_WIDTH_PX = 168;

function compactLabelText(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function estimatedTextWidth(value: string, characterWidth: number) {
  return value.length * characterWidth + LABEL_HORIZONTAL_PADDING_PX;
}

function wrappedTitleLines(label: string) {
  const compact = compactLabelText(label);
  const words = compact.split(' ');
  if (
    words.length < 2 ||
    estimatedTextWidth(compact, LABEL_TITLE_CHARACTER_WIDTH_PX) <=
      LABEL_MAX_SINGLE_LINE_TITLE_WIDTH_PX
  ) {
    return [compact];
  }

  let bestLines = [compact];
  let bestMaximumWidth = Number.POSITIVE_INFINITY;
  let bestLeadingJoinerPenalty = Number.POSITIVE_INFINITY;
  let bestImbalance = Number.POSITIVE_INFINITY;
  for (let splitIndex = 1; splitIndex < words.length; splitIndex += 1) {
    const first = words.slice(0, splitIndex).join(' ');
    const second = words.slice(splitIndex).join(' ');
    const firstWidth = estimatedTextWidth(
      first,
      LABEL_TITLE_CHARACTER_WIDTH_PX,
    );
    const secondWidth = estimatedTextWidth(
      second,
      LABEL_TITLE_CHARACTER_WIDTH_PX,
    );
    const maximumWidth = Math.max(firstWidth, secondWidth);
    const leadingJoinerPenalty = /^(?:&|and\b|or\b)/i.test(second) ? 1 : 0;
    const imbalance = Math.abs(firstWidth - secondWidth);
    if (
      maximumWidth < bestMaximumWidth ||
      (maximumWidth === bestMaximumWidth &&
        (leadingJoinerPenalty < bestLeadingJoinerPenalty ||
          (leadingJoinerPenalty === bestLeadingJoinerPenalty &&
            imbalance < bestImbalance)))
    ) {
      bestLines = [first, second];
      bestMaximumWidth = maximumWidth;
      bestLeadingJoinerPenalty = leadingJoinerPenalty;
      bestImbalance = imbalance;
    }
  }
  return bestLines;
}

/**
 * The browser and offline solver share this deterministic label geometry.
 * Longer titles wrap at a word boundary onto at most two explicit lines; the
 * returned lines are the rendering contract, avoiding browser-dependent line
 * breaking or font measurement during layout generation.
 */
export function canonicalIslandLabelSize(
  island: Pick<MapLayoutIsland, 'label' | 'kicker'>,
) {
  const titleLines = wrappedTitleLines(island.label);
  const titleWidth = Math.max(
    ...titleLines.map((line) =>
      estimatedTextWidth(line, LABEL_TITLE_CHARACTER_WIDTH_PX),
    ),
  );
  const kickerWidth = estimatedTextWidth(
    compactLabelText(island.kicker),
    LABEL_KICKER_CHARACTER_WIDTH_PX,
  );
  return {
    width: Math.max(LABEL_MINIMUM_WIDTH_PX, titleWidth, kickerWidth),
    height:
      LABEL_SINGLE_LINE_HEIGHT_PX +
      (titleLines.length - 1) * ISLAND_LABEL_TITLE_LINE_HEIGHT_PX,
    titleLines,
  };
}

export function islandLabelAnchor(island: MapLayoutIsland) {
  return {
    x: island.x + island.width * 0.5,
    y: island.y + island.height * 0.28,
  };
}

export function islandPackingAnchor(island: MapLayoutIsland) {
  return {
    x: island.x + island.width * 0.5,
    y: island.y + island.height * 0.5,
  };
}
