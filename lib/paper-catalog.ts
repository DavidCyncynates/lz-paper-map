import landscape from '@/data/landscape.json';

export type CatalogPaper = (typeof landscape.papers)[number];
export type CatalogIsland = (typeof landscape.islands)[number];

export { landscape };

export const paperById = new Map(
  landscape.papers.map((paper) => [paper.id, paper]),
);

export const islandById = new Map(
  landscape.islands.map((island) => [island.id, island]),
);

export function papersCitedBy(paperId: string) {
  return landscape.papers.filter((paper) => paper.cites.includes(paperId));
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
