export type IslandShapePoint = {
  x: number;
  y: number;
  /** Radius already occupied by the rendered body, in SVG viewBox units. */
  radius?: number;
};

export type IslandShapeOptions = {
  /** Empty space beyond every body. Defaults to 22 viewBox units. */
  padding?: number;
  /** Samples used to approximate each padded body. Defaults to 12. */
  samplesPerPoint?: number;
  /** Catmull-Rom smoothing amount in the inclusive range 0..1. */
  smoothing?: number;
  /** Decimal places written to the SVG path. Defaults to 2. */
  precision?: number;
};

type Point = { x: number; y: number };

const DEFAULT_PADDING = 22;
const DEFAULT_SAMPLES_PER_POINT = 12;
const DEFAULT_SMOOTHING = 0.62;
const DEFAULT_PRECISION = 2;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cross(origin: Point, first: Point, second: Point) {
  return (
    (first.x - origin.x) * (second.y - origin.y) -
    (first.y - origin.y) * (second.x - origin.x)
  );
}

function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points]
    .sort((first, second) => first.x - second.x || first.y - second.y)
    .filter(
      (point, index, values) =>
        index === 0 ||
        point.x !== values[index - 1].x ||
        point.y !== values[index - 1].y,
    );
  if (sorted.length <= 2) return sorted;

  const lower: Point[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function numberFormatter(precision: number) {
  const scale = 10 ** precision;
  return (value: number) => {
    const rounded = Math.round(value * scale) / scale;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  };
}

/**
 * Creates a deterministic, padded, smoothed convex envelope around bodies.
 * Coordinates, radii, and padding must all use the SVG viewBox's units.
 */
export function createSmoothedIslandPath(
  points: readonly IslandShapePoint[],
  options: IslandShapeOptions = {},
): string | null {
  const padding = Math.max(0, options.padding ?? DEFAULT_PADDING);
  const samplesPerPoint = Math.round(
    clamp(options.samplesPerPoint ?? DEFAULT_SAMPLES_PER_POINT, 8, 32),
  );
  const smoothing = clamp(options.smoothing ?? DEFAULT_SMOOTHING, 0, 1);
  const precision = Math.round(
    clamp(options.precision ?? DEFAULT_PRECISION, 0, 5),
  );
  const validPoints = points.filter(
    (point) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      (point.radius === undefined || Number.isFinite(point.radius)),
  );
  if (!validPoints.length) return null;

  const perimeterSamples = validPoints.flatMap((point) => {
    const radius = Math.max(0.5, Math.max(0, point.radius ?? 0) + padding);
    return Array.from({ length: samplesPerPoint }, (_, index) => {
      const angle = (index / samplesPerPoint) * Math.PI * 2;
      return {
        x: point.x + Math.cos(angle) * radius,
        y: point.y + Math.sin(angle) * radius,
      };
    });
  });
  const hull = convexHull(perimeterSamples);
  if (hull.length < 3) return null;

  const format = numberFormatter(precision);
  const commands = [`M ${format(hull[0].x)} ${format(hull[0].y)}`];
  const controlScale = smoothing / 6;
  for (let index = 0; index < hull.length; index += 1) {
    const previous = hull[(index - 1 + hull.length) % hull.length];
    const current = hull[index];
    const next = hull[(index + 1) % hull.length];
    const following = hull[(index + 2) % hull.length];
    const firstControl = {
      x: current.x + (next.x - previous.x) * controlScale,
      y: current.y + (next.y - previous.y) * controlScale,
    };
    const secondControl = {
      x: next.x - (following.x - current.x) * controlScale,
      y: next.y - (following.y - current.y) * controlScale,
    };
    commands.push(
      `C ${format(firstControl.x)} ${format(firstControl.y)} ${format(secondControl.x)} ${format(secondControl.y)} ${format(next.x)} ${format(next.y)}`,
    );
  }
  commands.push('Z');
  return commands.join(' ');
}
