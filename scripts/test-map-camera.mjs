import assert from 'node:assert/strict';
import test from 'node:test';

import {
  centeredMapStage,
  clampMapScale,
  dampMapWheelScale,
  DEFAULT_MAP_MAX_SCALE,
  DEFAULT_MAP_MIN_SCALE,
  DEFAULT_MAP_WHEEL_DAMPING_TIME_CONSTANT_MS,
  DEFAULT_MAP_WHEEL_EXPONENT_LIMIT,
  DEFAULT_MAP_WHEEL_SENSITIVITY,
  fitMapCamera,
  fitMapScale,
  mapWheelTargetScale,
  transformMapBetweenAnchors,
  zoomMapAtAnchor,
} from '../lib/map-camera.ts';

const EPSILON = 1e-9;

function near(actual, expected, epsilon = EPSILON) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function worldPointAtAnchor(viewport, world, camera, anchor) {
  const stage = centeredMapStage(viewport, world, camera.scale);
  return {
    x: (camera.scrollLeft + anchor.x - stage.offsetX) / camera.scale,
    y: (camera.scrollTop + anchor.y - stage.offsetY) / camera.scale,
  };
}

test('fit scale contains the map with padding and never enlarges by default', () => {
  const viewport = { width: 800, height: 600 };
  const world = { width: 1600, height: 1000 };
  const scale = fitMapScale(viewport, world, { padding: 20 });
  near(scale, 0.475);

  const camera = fitMapCamera(viewport, world, { padding: 20 });
  near(camera.scale, scale);
  near(camera.scrollLeft, 0);
  near(camera.scrollTop, 0);
  assert.ok(world.width * camera.scale <= viewport.width - 40 + EPSILON);
  assert.ok(world.height * camera.scale <= viewport.height - 40 + EPSILON);

  near(
    fitMapScale(
      { width: 1800, height: 1200 },
      { width: 400, height: 300 },
      { padding: 20 },
    ),
    1,
  );
  near(
    fitMapScale(
      { width: 1800, height: 1200 },
      { width: 400, height: 300 },
      { padding: 20, maximumFitScale: 1.4 },
    ),
    1.4,
  );

  const narrowCamera = fitMapCamera(
    { width: 298, height: 558 },
    { width: 1384, height: 1032 },
    { padding: 24 },
  );
  assert.ok(narrowCamera.scale > DEFAULT_MAP_MIN_SCALE);
  assert.ok(1384 * narrowCamera.scale <= 298 - 48 + EPSILON);
  assert.ok(1032 * narrowCamera.scale <= 558 - 48 + EPSILON);
});

test('scale clamping honors default and custom bounds', () => {
  near(clampMapScale(0.05), DEFAULT_MAP_MIN_SCALE);
  near(clampMapScale(8), DEFAULT_MAP_MAX_SCALE);
  near(clampMapScale(0.9), 0.9);
  near(clampMapScale(0.2, { minScale: 0.4, maxScale: 1.8 }), 0.4);
  near(clampMapScale(3, { minScale: 0.4, maxScale: 1.8 }), 1.8);

  near(
    fitMapScale(
      { width: 300, height: 200 },
      { width: 2000, height: 1600 },
      { padding: 24, minScale: 0.35 },
    ),
    0.35,
  );
});

test('wheel deltas create gentle reciprocal log-scale targets', () => {
  const zoomIn = mapWheelTargetScale(1, -100);
  const zoomOut = mapWheelTargetScale(1, 100);

  near(zoomIn, Math.exp(100 * DEFAULT_MAP_WHEEL_SENSITIVITY));
  near(zoomOut, Math.exp(-100 * DEFAULT_MAP_WHEEL_SENSITIVITY));
  near(zoomIn * zoomOut, 1);
});

test('wheel targets clamp each event and the resulting map scale', () => {
  near(
    mapWheelTargetScale(1, -100_000),
    Math.exp(DEFAULT_MAP_WHEEL_EXPONENT_LIMIT),
  );
  near(
    mapWheelTargetScale(1, 100_000),
    Math.exp(-DEFAULT_MAP_WHEEL_EXPONENT_LIMIT),
  );
  near(mapWheelTargetScale(2.45, -100_000), DEFAULT_MAP_MAX_SCALE);
  near(mapWheelTargetScale(0.16, 100_000), DEFAULT_MAP_MIN_SCALE);
  near(
    mapWheelTargetScale(1.9, -1_000, {
      minScale: 0.5,
      maxScale: 2,
      sensitivity: 0.01,
      exponentLimit: 0.1,
    }),
    2,
  );
});

test('wheel damping is time-based and honors reduced motion', () => {
  const oneInterval = dampMapWheelScale(1, 2, 60);
  near(
    oneInterval,
    2 - Math.exp(-60 / DEFAULT_MAP_WHEEL_DAMPING_TIME_CONSTANT_MS),
  );

  const firstInterval = dampMapWheelScale(1, 2, 20);
  const splitIntervals = dampMapWheelScale(firstInterval, 2, 40);
  near(splitIntervals, oneInterval);
  near(dampMapWheelScale(1, 2, 0), 1);
  near(dampMapWheelScale(1, 2, 1, { reducedMotion: true }), 2);
});

test('wheel helpers validate finite inputs and configuration', () => {
  assert.throws(
    () => mapWheelTargetScale(1, Number.NaN),
    /Map wheel delta must be finite/,
  );
  assert.throws(
    () => mapWheelTargetScale(0, 10),
    /Current map scale must be finite and positive/,
  );
  assert.throws(
    () => mapWheelTargetScale(1, 10, { sensitivity: -0.1 }),
    /Map wheel sensitivity must be finite and non-negative/,
  );
  assert.throws(
    () =>
      mapWheelTargetScale(1, 10, {
        exponentLimit: Number.POSITIVE_INFINITY,
      }),
    /Map wheel exponent limit must be finite and non-negative/,
  );
  assert.throws(
    () => dampMapWheelScale(1, 2, Number.NaN),
    /Map wheel elapsed time must be finite and non-negative/,
  );
  assert.throws(
    () => dampMapWheelScale(1, Number.POSITIVE_INFINITY, 16),
    /Target map scale must be finite and positive/,
  );
  assert.throws(
    () => dampMapWheelScale(1, 2, 16, { timeConstantMs: 0 }),
    /Map wheel damping time constant must be finite and positive/,
  );
});

test('zoom preserves the world point beneath an unconstrained cursor', () => {
  const viewport = { width: 800, height: 600 };
  const world = { width: 1600, height: 1200 };
  const anchor = { x: 220, y: 160 };
  const current = { scale: 0.8, scrollLeft: 240, scrollTop: 180 };
  const before = worldPointAtAnchor(viewport, world, current, anchor);
  const next = zoomMapAtAnchor({
    viewport,
    world,
    current,
    nextScale: 1.25,
    anchor,
  });
  const after = worldPointAtAnchor(viewport, world, next, anchor);

  near(next.scale, 1.25);
  near(after.x, before.x);
  near(after.y, before.y);
});

test('zoom accounts for a world centered inside a larger viewport', () => {
  const viewport = { width: 800, height: 600 };
  const world = { width: 1600, height: 1200 };
  const anchor = { x: 400, y: 300 };
  const current = { scale: 0.4, scrollLeft: 0, scrollTop: 0 };
  const currentStage = centeredMapStage(viewport, world, current.scale);
  near(currentStage.offsetX, 80);
  near(currentStage.offsetY, 60);

  const before = worldPointAtAnchor(viewport, world, current, anchor);
  const next = zoomMapAtAnchor({
    viewport,
    world,
    current,
    nextScale: 0.8,
    anchor,
  });
  const after = worldPointAtAnchor(viewport, world, next, anchor);

  near(next.scrollLeft, 240);
  near(next.scrollTop, 180);
  near(after.x, before.x);
  near(after.y, before.y);
});

test('pinch preserves the anchored world point while its midpoint moves', () => {
  const viewport = { width: 800, height: 600 };
  const world = { width: 1600, height: 1200 };
  const currentAnchor = { x: 310, y: 260 };
  const nextAnchor = { x: 365, y: 225 };
  const current = { scale: 0.8, scrollLeft: 250, scrollTop: 170 };
  const before = worldPointAtAnchor(viewport, world, current, currentAnchor);
  const next = transformMapBetweenAnchors({
    viewport,
    world,
    current,
    nextScale: 1.2,
    currentAnchor,
    nextAnchor,
  });
  const after = worldPointAtAnchor(viewport, world, next, nextAnchor);

  near(next.scale, 1.2);
  near(after.x, before.x);
  near(after.y, before.y);
});

test('a same-scale gesture translates the map with its midpoint', () => {
  const next = transformMapBetweenAnchors({
    viewport: { width: 600, height: 420 },
    world: { width: 1400, height: 1000 },
    current: { scale: 1, scrollLeft: 380, scrollTop: 260 },
    nextScale: 1,
    currentAnchor: { x: 250, y: 180 },
    nextAnchor: { x: 290, y: 205 },
  });

  near(next.scrollLeft, 340);
  near(next.scrollTop, 235);
});

test('zoom clamps scale, anchor, stale scroll, and final scroll bounds', () => {
  const viewport = { width: 500, height: 400 };
  const world = { width: 900, height: 700 };
  const next = zoomMapAtAnchor({
    viewport,
    world,
    current: { scale: 1, scrollLeft: -40, scrollTop: 50_000 },
    nextScale: 20,
    anchor: { x: 5_000, y: -200 },
    minScale: 0.5,
    maxScale: 2,
  });
  const stage = centeredMapStage(viewport, world, next.scale);

  near(next.scale, 2);
  assert.ok(next.scrollLeft >= 0 && next.scrollLeft <= stage.maxScrollLeft);
  assert.ok(next.scrollTop >= 0 && next.scrollTop <= stage.maxScrollTop);
});

test('mount-time zero sizes remain finite and invalid geometry fails early', () => {
  const zeroViewport = { width: 0, height: 0 };
  const ordinaryWorld = { width: 1200, height: 800 };
  near(fitMapScale(zeroViewport, ordinaryWorld), DEFAULT_MAP_MIN_SCALE);
  assert.deepEqual(fitMapCamera(zeroViewport, ordinaryWorld), {
    scale: DEFAULT_MAP_MIN_SCALE,
    scrollLeft: 0,
    scrollTop: 0,
  });

  const zeroWorldCamera = fitMapCamera(
    { width: 800, height: 600 },
    { width: 0, height: 0 },
  );
  assert.deepEqual(zeroWorldCamera, {
    scale: 1,
    scrollLeft: 0,
    scrollTop: 0,
  });

  near(
    fitMapScale(
      { width: 40, height: 40 },
      { width: 1000, height: 1000 },
      { padding: 100 },
    ),
    DEFAULT_MAP_MIN_SCALE,
  );

  assert.throws(
    () => centeredMapStage({ width: -1, height: 10 }, ordinaryWorld, 1),
    /Viewport width must be finite and non-negative/,
  );
  assert.throws(
    () => fitMapScale({ width: 100, height: Number.NaN }, ordinaryWorld),
    /Viewport height must be finite and non-negative/,
  );
  assert.throws(
    () => clampMapScale(Number.POSITIVE_INFINITY),
    /Map scale must be finite/,
  );
  assert.throws(
    () => clampMapScale(1, { minScale: 2, maxScale: 1 }),
    /Maximum map scale must be greater than or equal to minimum map scale/,
  );
  assert.throws(
    () =>
      zoomMapAtAnchor({
        viewport: { width: 800, height: 600 },
        world: ordinaryWorld,
        current: { scale: 1, scrollLeft: 0, scrollTop: 0 },
        nextScale: 1.2,
        anchor: { x: Number.NaN, y: 100 },
      }),
    /Map zoom anchor must be finite/,
  );
});
