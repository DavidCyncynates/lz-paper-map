import { paperInDateRange, type PaperDateRange } from './paper-date-range.ts';

type FilterablePaper = {
  id: string;
  primaryIsland: string;
  published: string;
  contribution: string;
};

type PaperFilters = {
  query: string;
  islandId: string;
  dateRange: PaperDateRange;
  contribution: string;
};

export function normalizeSearchText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Intersect filters without changing catalog order or its stored layout. */
export function filterCatalogPapers<T extends FilterablePaper>(
  papers: readonly T[],
  filters: PaperFilters,
  searchIndex: ReadonlyMap<string, string>,
): T[] {
  const query = normalizeSearchText(filters.query);
  return papers.filter(
    (paper) =>
      (filters.islandId === 'all' ||
        paper.primaryIsland === filters.islandId) &&
      (filters.contribution === 'all' ||
        paper.contribution === filters.contribution) &&
      paperInDateRange(paper, filters.dateRange) &&
      (!query || Boolean(searchIndex.get(paper.id)?.includes(query))),
  );
}
