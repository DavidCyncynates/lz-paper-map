export type MapCameraSize = {
  width: number;
  height: number;
};

export type MapCameraPoint = {
  x: number;
  y: number;
};

export type MapCameraState = {
  scale: number;
  scrollLeft: number;
  scrollTop: number;
};

export type MapCameraBounds = {
  minScale?: number;
  maxScale?: number;
};

export type MapFitOptions = MapCameraBounds & {
  padding?: number;
  maximumFitScale?: number;
};

export type CenteredMapStage = {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  maxScrollLeft: number;
  maxScrollTop: number;
};

export const DEFAULT_MAP_MIN_SCALE = 0.15;
export const DEFAULT_MAP_MAX_SCALE = 2.5;
export const DEFAULT_MAP_FIT_PADDING = 24;
export const DEFAULT_MAP_MAXIMUM_FIT_SCALE = 1;
export const DEFAULT_MAP_WHEEL_SENSITIVITY = 0.00135;
export const DEFAULT_MAP_WHEEL_EXPONENT_LIMIT = 0.18;
export const DEFAULT_MAP_WHEEL_DAMPING_TIME_CONSTANT_MS = 60;

const CAMERA_EPSILON = 1e-9;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFiniteNonnegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative.`);
  }
}

function assertFinitePositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive.`);
  }
}

function assertFinite(value: number, label: string) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite.`);
  }
}

function validateSize(size: MapCameraSize, label: string) {
  assertFiniteNonnegative(size.width, `${label} width`);
  assertFiniteNonnegative(size.height, `${label} height`);
}

function resolvedBounds(bounds: MapCameraBounds = {}) {
  const minScale = bounds.minScale ?? DEFAULT_MAP_MIN_SCALE;
  const maxScale = bounds.maxScale ?? DEFAULT_MAP_MAX_SCALE;
  assertFinitePositive(minScale, 'Minimum map scale');
  assertFinitePositive(maxScale, 'Maximum map scale');
  if (maxScale < minScale) {
    throw new RangeError(
      'Maximum map scale must be greater than or equal to minimum map scale.',
    );
  }
  return { minScale, maxScale };
}

export function clampMapScale(scale: number, bounds: MapCameraBounds = {}) {
  if (!Number.isFinite(scale)) {
    throw new RangeError('Map scale must be finite.');
  }
  const { minScale, maxScale } = resolvedBounds(bounds);
  return clamp(scale, minScale, maxScale);
}

export type MapWheelTargetScaleOptions = MapCameraBounds & {
  /** Log-scale change applied for each normalized wheel pixel. */
  sensitivity?: number;
  /** Maximum absolute log-scale change accepted from a single wheel event. */
  exponentLimit?: number;
};

export type DampMapWheelScaleOptions = MapCameraBounds & {
  /** Exponential smoothing time constant in milliseconds. */
  timeConstantMs?: number;
  /** Skip interpolation for people who prefer reduced motion. */
  reducedMotion?: boolean;
};

/**
 * Converts a normalized wheel delta into a bounded zoom target. Working in
 * log scale makes equal upward and downward deltas reciprocal, while the
 * per-event exponent limit prevents a single coarse wheel event from causing
 * a disorienting jump.
 */
export function mapWheelTargetScale(
  currentScale: number,
  deltaPixels: number,
  options: MapWheelTargetScaleOptions = {},
) {
  assertFinitePositive(currentScale, 'Current map scale');
  assertFinite(deltaPixels, 'Map wheel delta');
  const sensitivity = options.sensitivity ?? DEFAULT_MAP_WHEEL_SENSITIVITY;
  const exponentLimit =
    options.exponentLimit ?? DEFAULT_MAP_WHEEL_EXPONENT_LIMIT;
  assertFiniteNonnegative(sensitivity, 'Map wheel sensitivity');
  assertFiniteNonnegative(exponentLimit, 'Map wheel exponent limit');

  const bounds = resolvedBounds(options);
  const boundedCurrentScale = clamp(
    currentScale,
    bounds.minScale,
    bounds.maxScale,
  );
  const exponent = clamp(
    -deltaPixels * sensitivity,
    -exponentLimit,
    exponentLimit,
  );
  const unboundedTarget = boundedCurrentScale * Math.exp(exponent);
  return clamp(unboundedTarget, bounds.minScale, bounds.maxScale);
}

/**
 * Advances a wheel-zoom scale toward its target using time-based exponential
 * damping. The result is independent of frame rate: two successive intervals
 * have the same effect as one interval of their combined duration.
 */
export function dampMapWheelScale(
  currentScale: number,
  targetScale: number,
  elapsedMs: number,
  options: DampMapWheelScaleOptions = {},
) {
  assertFinitePositive(currentScale, 'Current map scale');
  assertFinitePositive(targetScale, 'Target map scale');
  assertFiniteNonnegative(elapsedMs, 'Map wheel elapsed time');
  const timeConstantMs =
    options.timeConstantMs ?? DEFAULT_MAP_WHEEL_DAMPING_TIME_CONSTANT_MS;
  assertFinitePositive(timeConstantMs, 'Map wheel damping time constant');

  const bounds = resolvedBounds(options);
  const boundedCurrentScale = clamp(
    currentScale,
    bounds.minScale,
    bounds.maxScale,
  );
  const boundedTargetScale = clamp(
    targetScale,
    bounds.minScale,
    bounds.maxScale,
  );
  if (options.reducedMotion) return boundedTargetScale;

  const retainedDifference = Math.exp(-elapsedMs / timeConstantMs);
  return clamp(
    boundedTargetScale +
      (boundedCurrentScale - boundedTargetScale) * retainedDifference,
    bounds.minScale,
    bounds.maxScale,
  );
}

/**
 * Describes the scrollable stage used by the map renderer. When the scaled
 * world is smaller than the viewport, the world is centered inside the stage;
 * otherwise the stage grows to the scaled world size.
 */
export function centeredMapStage(
  viewport: MapCameraSize,
  world: MapCameraSize,
  scale: number,
): CenteredMapStage {
  validateSize(viewport, 'Viewport');
  validateSize(world, 'World');
  assertFinitePositive(scale, 'Map scale');

  const scaledWorldWidth = world.width * scale;
  const scaledWorldHeight = world.height * scale;
  if (
    !Number.isFinite(scaledWorldWidth) ||
    !Number.isFinite(scaledWorldHeight)
  ) {
    throw new RangeError('Scaled map dimensions must be finite.');
  }
  const width = Math.max(viewport.width, scaledWorldWidth);
  const height = Math.max(viewport.height, scaledWorldHeight);

  return {
    width,
    height,
    offsetX: (width - scaledWorldWidth) / 2,
    offsetY: (height - scaledWorldHeight) / 2,
    maxScrollLeft: Math.max(0, width - viewport.width),
    maxScrollTop: Math.max(0, height - viewport.height),
  };
}

/**
 * Returns a bounded scale that contains the full map inside the viewport.
 * A zero-sized viewport can occur briefly while the map is mounting; returning
 * the minimum scale keeps that state finite and deterministic.
 */
export function fitMapScale(
  viewport: MapCameraSize,
  world: MapCameraSize,
  options: MapFitOptions = {},
) {
  validateSize(viewport, 'Viewport');
  validateSize(world, 'World');
  const bounds = resolvedBounds(options);
  const padding = options.padding ?? DEFAULT_MAP_FIT_PADDING;
  const maximumFitScale =
    options.maximumFitScale ?? DEFAULT_MAP_MAXIMUM_FIT_SCALE;
  assertFiniteNonnegative(padding, 'Map fit padding');
  assertFinitePositive(maximumFitScale, 'Maximum map fit scale');

  if (viewport.width <= CAMERA_EPSILON || viewport.height <= CAMERA_EPSILON) {
    return bounds.minScale;
  }
  if (world.width <= CAMERA_EPSILON || world.height <= CAMERA_EPSILON) {
    return clampMapScale(
      Math.min(maximumFitScale, DEFAULT_MAP_MAXIMUM_FIT_SCALE),
      bounds,
    );
  }

  const availableWidth = Math.max(0, viewport.width - padding * 2);
  const availableHeight = Math.max(0, viewport.height - padding * 2);
  const unboundedScale = Math.min(
    availableWidth / world.width,
    availableHeight / world.height,
    maximumFitScale,
  );
  return clampMapScale(unboundedScale, bounds);
}

export function fitMapCamera(
  viewport: MapCameraSize,
  world: MapCameraSize,
  options: MapFitOptions = {},
): MapCameraState {
  const scale = fitMapScale(viewport, world, options);
  if (viewport.width <= CAMERA_EPSILON || viewport.height <= CAMERA_EPSILON) {
    return { scale, scrollLeft: 0, scrollTop: 0 };
  }
  const stage = centeredMapStage(viewport, world, scale);
  return {
    scale,
    scrollLeft: stage.maxScrollLeft / 2,
    scrollTop: stage.maxScrollTop / 2,
  };
}

export type ZoomMapAtAnchorInput = MapCameraBounds & {
  viewport: MapCameraSize;
  world: MapCameraSize;
  current: MapCameraState;
  nextScale: number;
  /** Coordinates relative to the viewport's top-left corner. */
  anchor: MapCameraPoint;
};

export type TransformMapBetweenAnchorsInput = MapCameraBounds & {
  viewport: MapCameraSize;
  world: MapCameraSize;
  current: MapCameraState;
  nextScale: number;
  /** The viewport-local point where the gesture began. */
  currentAnchor: MapCameraPoint;
  /** The viewport-local point where that same gesture point has moved. */
  nextAnchor: MapCameraPoint;
};

/**
 * Changes map scale while preserving the world point beneath a viewport-local
 * anchor (for example, the cursor or the pinch midpoint). Scroll limits are
 * applied last, so anchors near an edge degrade to the nearest valid view.
 */
export function zoomMapAtAnchor({
  viewport,
  world,
  current,
  nextScale,
  anchor,
  minScale,
  maxScale,
}: ZoomMapAtAnchorInput): MapCameraState {
  validateSize(viewport, 'Viewport');
  validateSize(world, 'World');
  assertFinitePositive(current.scale, 'Current map scale');
  // Browsers can briefly report negative scroll positions during elastic
  // overscroll. They are finite camera inputs and are clamped below.
  assertFinite(current.scrollLeft, 'Map scroll left');
  assertFinite(current.scrollTop, 'Map scroll top');
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    throw new RangeError('Map zoom anchor must be finite.');
  }

  const bounds = resolvedBounds({ minScale, maxScale });
  const scale = clampMapScale(nextScale, bounds);
  const currentStage = centeredMapStage(viewport, world, current.scale);
  const nextStage = centeredMapStage(viewport, world, scale);
  const anchorX = clamp(anchor.x, 0, viewport.width);
  const anchorY = clamp(anchor.y, 0, viewport.height);
  const currentScrollLeft = clamp(
    current.scrollLeft,
    0,
    currentStage.maxScrollLeft,
  );
  const currentScrollTop = clamp(
    current.scrollTop,
    0,
    currentStage.maxScrollTop,
  );
  const worldX =
    (currentScrollLeft + anchorX - currentStage.offsetX) / current.scale;
  const worldY =
    (currentScrollTop + anchorY - currentStage.offsetY) / current.scale;

  return {
    scale,
    scrollLeft: clamp(
      nextStage.offsetX + worldX * scale - anchorX,
      0,
      nextStage.maxScrollLeft,
    ),
    scrollTop: clamp(
      nextStage.offsetY + worldY * scale - anchorY,
      0,
      nextStage.maxScrollTop,
    ),
  };
}

/**
 * Applies a combined pan and zoom while keeping the world point beneath the
 * first anchor beneath the second anchor. This is the camera operation behind
 * a two-finger pinch: finger separation controls scale while midpoint motion
 * pans the map.
 */
export function transformMapBetweenAnchors({
  viewport,
  world,
  current,
  nextScale,
  currentAnchor,
  nextAnchor,
  minScale,
  maxScale,
}: TransformMapBetweenAnchorsInput): MapCameraState {
  validateSize(viewport, 'Viewport');
  validateSize(world, 'World');
  assertFinitePositive(current.scale, 'Current map scale');
  assertFinite(current.scrollLeft, 'Map scroll left');
  assertFinite(current.scrollTop, 'Map scroll top');
  if (
    !Number.isFinite(currentAnchor.x) ||
    !Number.isFinite(currentAnchor.y) ||
    !Number.isFinite(nextAnchor.x) ||
    !Number.isFinite(nextAnchor.y)
  ) {
    throw new RangeError('Map gesture anchors must be finite.');
  }

  const bounds = resolvedBounds({ minScale, maxScale });
  const scale = clampMapScale(nextScale, bounds);
  const currentStage = centeredMapStage(viewport, world, current.scale);
  const nextStage = centeredMapStage(viewport, world, scale);
  const startX = clamp(currentAnchor.x, 0, viewport.width);
  const startY = clamp(currentAnchor.y, 0, viewport.height);
  const endX = clamp(nextAnchor.x, 0, viewport.width);
  const endY = clamp(nextAnchor.y, 0, viewport.height);
  const currentScrollLeft = clamp(
    current.scrollLeft,
    0,
    currentStage.maxScrollLeft,
  );
  const currentScrollTop = clamp(
    current.scrollTop,
    0,
    currentStage.maxScrollTop,
  );
  const worldX =
    (currentScrollLeft + startX - currentStage.offsetX) / current.scale;
  const worldY =
    (currentScrollTop + startY - currentStage.offsetY) / current.scale;

  return {
    scale,
    scrollLeft: clamp(
      nextStage.offsetX + worldX * scale - endX,
      0,
      nextStage.maxScrollLeft,
    ),
    scrollTop: clamp(
      nextStage.offsetY + worldY * scale - endY,
      0,
      nextStage.maxScrollTop,
    ),
  };
}
