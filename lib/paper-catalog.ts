import landscape from '@/data/landscape.json';
import generatedCatalogIndex from '@/data/generated/catalog-index.json';

import { resolveCatalogIndex } from './catalog-index.mjs';

export type CatalogPaper = (typeof landscape.papers)[number];
export type CatalogIsland = (typeof landscape.islands)[number];

export { landscape };

export const paperById = new Map(
  landscape.papers.map((paper) => [paper.id, paper]),
);

export const islandById = new Map(
  landscape.islands.map((island) => [island.id, island]),
);

const resolvedCatalogIndex = resolveCatalogIndex(
  landscape,
  generatedCatalogIndex,
  { warn: (message: string) => console.warn(message) },
);
const catalogIndex = resolvedCatalogIndex.index;

export const catalogIndexSource = resolvedCatalogIndex.source;

export const incomingCitationCountById = new Map(
  landscape.papers.map((paper) => [
    paper.id,
    catalogIndex.papers[paper.id]?.incomingCitationCount ?? 0,
  ]),
);

export const normalizedSearchTextById = new Map(
  landscape.papers.map((paper) => [
    paper.id,
    catalogIndex.papers[paper.id]?.searchText ?? '',
  ]),
);

export function papersCitedBy(paperId: string) {
  return (catalogIndex.papers[paperId]?.citedBy ?? []).flatMap(
    (citingPaperId: string) => {
      const citingPaper = paperById.get(citingPaperId);
      return citingPaper ? [citingPaper] : [];
    },
  );
}

export function papersCitedByPaper(paper: CatalogPaper) {
  return paper.cites.flatMap((paperId) => {
    const citedPaper = paperById.get(paperId);
    return citedPaper ? [citedPaper] : [];
  });
}

export function paperRoleLabel(role: CatalogPaper['role']) {
  const labels: Record<CatalogPaper['role'], string> = {
    observation: 'Source result',
    explanation: 'Interpretation',
    constraint: 'Constraint',
    diagnostic: 'Discriminant',
    adjacent: 'Adjacent work',
  };
  return labels[role];
}
