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
export const MAP_LAYOUT_SOLVER_VERSION = 3;
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

/**
 * The browser renders island labels on a fixed 1160px map world. These
 * conservative, deterministic boxes remove font measurement from the layout
 * algorithm while leaving enough room for the actual nowrap label text.
 */
export function canonicalIslandLabelSize(
  island: Pick<MapLayoutIsland, 'label' | 'kicker'>,
) {
  return {
    width: Math.max(
      92,
      island.label.length * 7.4 + 8,
      island.kicker.length * 5.5 + 8,
    ),
    height: 34,
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
