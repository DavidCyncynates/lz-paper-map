export type CitationPaper = {
  id: string;
  cites: readonly string[];
};

export const CITATION_DIAMETER_MIN_PX = 12;
export const CITATION_DIAMETER_MAX_PX = 28;
export const CITATION_SCALE_REFERENCE = 64;

export function incomingCitationCounts(
  papers: readonly CitationPaper[],
): Map<string, number> {
  const paperIds = new Set(papers.map((paper) => paper.id));
  const counts = new Map(papers.map((paper) => [paper.id, 0]));

  for (const paper of papers) {
    for (const citedId of new Set(paper.cites)) {
      if (citedId === paper.id || !paperIds.has(citedId)) continue;
      counts.set(citedId, (counts.get(citedId) ?? 0) + 1);
    }
  }

  return counts;
}

export function citationDiameter(
  citationCount: number,
  {
    minimum = CITATION_DIAMETER_MIN_PX,
    maximum = CITATION_DIAMETER_MAX_PX,
    reference = CITATION_SCALE_REFERENCE,
  }: {
    minimum?: number;
    maximum?: number;
    reference?: number;
  } = {},
): number {
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    !Number.isFinite(reference) ||
    minimum <= 0 ||
    maximum < minimum ||
    reference <= 0
  ) {
    throw new RangeError('Citation sizing requires positive, ordered bounds.');
  }

  const count = Number.isFinite(citationCount) ? Math.max(0, citationCount) : 0;
  const progress = Math.min(1, Math.log1p(count) / Math.log1p(reference));

  // Scale area, rather than diameter, with log(1 + citations). This keeps the
  // visual encoding perceptually restrained while preserving ordering.
  return Math.sqrt(minimum ** 2 + (maximum ** 2 - minimum ** 2) * progress);
}
