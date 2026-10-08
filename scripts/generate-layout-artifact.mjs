import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import landscape from '../data/landscape.json' with { type: 'json' };
import { createHierarchicalMapLayout } from '../lib/hierarchical-map-layout.ts';
import {
  canonicalIslandLabelSize,
  islandLabelAnchor,
  islandPackingAnchor,
  ISLAND_GAP_PX,
  ISLAND_PADDING_PX,
  MAP_LAYOUT_SCHEMA_VERSION,
  MAP_LAYOUT_SOLVER_VERSION,
  MAP_WORLD_HEIGHT,
  MAP_WORLD_WIDTH,
  mapPaperCollisionRadius,
  OBSERVATION_PACKING_PADDING_PX,
} from '../lib/map-layout-config.ts';
import { incomingCitationCounts } from '../lib/paper-citation-size.ts';

const OUTPUT_PATH = join(
  process.cwd(),
  'data',
  'generated',
  'map-layouts.json',
);
const MODES = ['uniform', 'citations'];

function digestCatalog() {
  const relevantCatalog = {
    schemaVersion: landscape.schemaVersion,
    papers: landscape.papers
      .map((paper) => ({
        id: paper.id,
        layoutRank: paper.layoutRank,
        primaryIsland: paper.primaryIsland,
        role: paper.role,
        x: paper.x,
        y: paper.y,
        cites: [...paper.cites].sort(),
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
    islands: landscape.islands
      .map((island) => ({
        id: island.id,
        label: island.label,
        kicker: island.kicker,
        x: island.x,
        y: island.y,
        width: island.width,
        height: island.height,
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
  };
  return createHash('sha256')
    .update(JSON.stringify(relevantCatalog))
    .digest('hex');
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function sortedObject(entries) {
  return Object.fromEntries(
    [...entries].sort(([first], [second]) => first.localeCompare(second)),
  );
}

function generateMode(mode, citationCounts) {
  const paperAnchors = landscape.papers.map((paper) => ({
    id: paper.id,
    islandId: paper.primaryIsland,
    stabilityRank: paper.layoutRank,
    x: (paper.x / 100) * MAP_WORLD_WIDTH,
    y: (paper.y / 100) * MAP_WORLD_HEIGHT,
    radius: mapPaperCollisionRadius(
      paper,
      mode,
      citationCounts.get(paper.id) ?? 0,
    ),
  }));
  const labelAnchors = landscape.islands.map((island) => {
    const anchor = islandLabelAnchor(island);
    const size = canonicalIslandLabelSize(island);
    return {
      id: island.id,
      islandId: island.id,
      x: (anchor.x / 100) * MAP_WORLD_WIDTH,
      y: (anchor.y / 100) * MAP_WORLD_HEIGHT,
      ...size,
    };
  });
  const islandAnchors = landscape.islands.map((island) => {
    const anchor = islandPackingAnchor(island);
    return {
      id: island.id,
      x: (anchor.x / 100) * MAP_WORLD_WIDTH,
      y: (anchor.y / 100) * MAP_WORLD_HEIGHT,
      semanticWidth: (island.width / 100) * MAP_WORLD_WIDTH,
      semanticHeight: (island.height / 100) * MAP_WORLD_HEIGHT,
      observation: island.id === 'observation',
    };
  });
  const layout = createHierarchicalMapLayout(
    MAP_WORLD_WIDTH,
    MAP_WORLD_HEIGHT,
    paperAnchors,
    labelAnchors,
    islandAnchors,
    {
      islandPadding: ISLAND_PADDING_PX,
      observationPadding: OBSERVATION_PACKING_PADDING_PX,
      outerGap: ISLAND_GAP_PX,
      allowCanvasExpansion: true,
    },
  );
  assert.equal(layout.diagnostics.converged, true, `${mode} layout failed`);

  return {
    width: layout.width,
    height: layout.height,
    papers: sortedObject(
      [...layout.papers].map(([id, point]) => [
        id,
        {
          x: round((point.x / layout.width) * 100),
          y: round((point.y / layout.height) * 100),
        },
      ]),
    ),
    labels: sortedObject(
      [...layout.labels].map(([id, point]) => [
        id,
        {
          x: round((point.x / layout.width) * 100),
          y: round((point.y / layout.height) * 100),
        },
      ]),
    ),
    islands: sortedObject(
      [...layout.islands].map(([id, island]) => [
        id,
        {
          x: round(island.x),
          y: round(island.y),
          radius: round(island.radius),
          contentRadius: round(island.contentRadius),
          padding: round(island.padding),
          semanticAnchor: {
            x: round(island.semanticAnchor.x),
            y: round(island.semanticAnchor.y),
          },
          observation: island.observation,
          drawBoundary: island.drawBoundary,
          anchorDrift: round(island.anchorDrift),
        },
      ]),
    ),
    diagnostics: Object.fromEntries(
      Object.entries(layout.diagnostics).map(([key, value]) => [
        key,
        typeof value === 'number' ? round(value) : value,
      ]),
    ),
  };
}

function generateArtifact() {
  const citationCounts = incomingCitationCounts(landscape.papers);
  return {
    schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
    solverVersion: MAP_LAYOUT_SOLVER_VERSION,
    catalogDigest: digestCatalog(),
    sourceUpdatedAt: landscape.updatedAt,
    modes: Object.fromEntries(
      MODES.map((mode) => [mode, generateMode(mode, citationCounts)]),
    ),
  };
}

if (process.argv.includes('--check')) {
  let current;
  try {
    current = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  } catch (error) {
    assert.fail(
      `data/generated/map-layouts.json is missing or invalid; run pnpm generate:layouts (${String(error)})`,
    );
  }
  const staleMessage =
    'data/generated/map-layouts.json is stale; run pnpm generate:layouts';
  assert.equal(current.schemaVersion, MAP_LAYOUT_SCHEMA_VERSION, staleMessage);
  assert.equal(current.solverVersion, MAP_LAYOUT_SOLVER_VERSION, staleMessage);
  assert.equal(current.catalogDigest, digestCatalog(), staleMessage);
  assert.equal(current.sourceUpdatedAt, landscape.updatedAt, staleMessage);
  assert.deepEqual(
    Object.keys(current.modes ?? {}).sort(),
    [...MODES].sort(),
    staleMessage,
  );

  const expectedPaperIds = landscape.papers.map((paper) => paper.id).sort();
  const expectedIslandIds = landscape.islands.map((island) => island.id).sort();
  for (const mode of MODES) {
    const layout = current.modes[mode];
    assert.ok(layout && layout.diagnostics?.converged === true, staleMessage);
    assert.deepEqual(
      Object.keys(layout.papers ?? {}).sort(),
      expectedPaperIds,
      staleMessage,
    );
    assert.deepEqual(
      Object.keys(layout.labels ?? {}).sort(),
      expectedIslandIds,
      staleMessage,
    );
    assert.deepEqual(
      Object.keys(layout.islands ?? {}).sort(),
      expectedIslandIds,
      staleMessage,
    );
  }
  console.log('Verified generated map layouts.');
} else {
  const serialized = `${JSON.stringify(generateArtifact(), null, 2)}\n`;
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serialized);
  console.log(
    `Generated ${MODES.length} map layouts for ${landscape.papers.length} papers.`,
  );
}
