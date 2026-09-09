export type PaperDateRange = Readonly<{
  from: string;
  to: string;
}>;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_FIELD_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const MILLISECONDS_PER_DAY = 86_400_000;

function isoFromParts(year: number, month: number, day: number) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 0 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseIsoDate(value: string | null | undefined) {
  if (!value) return null;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function parseDateField(value: string) {
  const match = DATE_FIELD_PATTERN.exec(value.trim());
  if (!match) return null;
  const shortYear = Number(match[3]);
  const year = match[3].length === 2 ? 2000 + shortYear : shortYear;
  return isoFromParts(year, Number(match[2]), Number(match[1]));
}

export function formatDateField(value: string) {
  const normalized = parseIsoDate(value);
  if (!normalized) throw new RangeError(`Invalid ISO date: ${value}`);
  const [year, month, day] = normalized.split('-');
  return `${day}/${month}/${year}`;
}

export function publicationDateBounds(
  papers: readonly { published: string }[],
): PaperDateRange {
  if (!papers.length) {
    throw new RangeError(
      'A publication-date range requires at least one paper.',
    );
  }

  const dates = papers.map((paper) => {
    const date = parseIsoDate(paper.published);
    if (!date) {
      throw new RangeError(
        `Invalid paper publication date: ${paper.published}`,
      );
    }
    return date;
  });
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

export function clampDateToBounds(value: string, bounds: PaperDateRange) {
  const normalized = parseIsoDate(value);
  if (!normalized) throw new RangeError(`Invalid ISO date: ${value}`);
  if (normalized < bounds.from) return bounds.from;
  if (normalized > bounds.to) return bounds.to;
  return normalized;
}

export function normalizeDateRange(
  candidate: Partial<PaperDateRange>,
  bounds: PaperDateRange,
): PaperDateRange {
  const parsedFrom = parseIsoDate(candidate.from) ?? bounds.from;
  const parsedTo = parseIsoDate(candidate.to) ?? bounds.to;
  const clampedFrom = clampDateToBounds(parsedFrom, bounds);
  const clampedTo = clampDateToBounds(parsedTo, bounds);
  return clampedFrom <= clampedTo
    ? { from: clampedFrom, to: clampedTo }
    : { from: clampedTo, to: clampedFrom };
}

export function paperInDateRange(
  paper: { published: string },
  range: PaperDateRange,
) {
  const published = parseIsoDate(paper.published);
  return Boolean(published && published >= range.from && published <= range.to);
}

export function isFullDateRange(range: PaperDateRange, bounds: PaperDateRange) {
  return range.from === bounds.from && range.to === bounds.to;
}

export function isoDateToDayIndex(value: string) {
  const normalized = parseIsoDate(value);
  if (!normalized) throw new RangeError(`Invalid ISO date: ${value}`);
  const [year, month, day] = normalized.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
}

export function dayIndexToIsoDate(dayIndex: number) {
  if (!Number.isInteger(dayIndex)) {
    throw new RangeError(`Invalid UTC day index: ${dayIndex}`);
  }
  return new Date(dayIndex * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

export function dateRangeFromSearchParams(
  params: Pick<URLSearchParams, 'get'>,
  bounds: PaperDateRange,
) {
  return normalizeDateRange(
    {
      from: parseIsoDate(params.get('from')) ?? undefined,
      to: parseIsoDate(params.get('to')) ?? undefined,
    },
    bounds,
  );
}

export function applyDateRangeToSearchParams(
  params: URLSearchParams,
  range: PaperDateRange,
  bounds: PaperDateRange,
) {
  const next = new URLSearchParams(params);
  if (isFullDateRange(range, bounds)) {
    next.delete('from');
    next.delete('to');
  } else {
    next.set('from', range.from);
    next.set('to', range.to);
  }
  return next;
}
