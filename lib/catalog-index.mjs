import { createHash } from 'node:crypto';

export const CATALOG_INDEX_SCHEMA_VERSION = 2;

/**
 * Recursively sort object keys so semantically identical JSON produces the
 * same digest even when its source formatting or property order changes.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalCatalogJson(catalog) {
  return JSON.stringify(canonicalize(catalog));
}

export function catalogDigest(catalog) {
  const digest = createHash('sha256')
    .update(canonicalCatalogJson(catalog))
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * Produce one accent-insensitive, punctuation-insensitive string for quick
 * client-side substring searches. Keep word order intact so phrase searches
 * continue to work.
 */
export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function paperSearchText(paper, islandById = new Map()) {
  const islandTerms = (paper.islands ?? []).flatMap((islandId) => {
    const island = islandById.get(islandId);
    if (!island) return [];
    return [island.id, island.label, island.shortLabel, island.kicker];
  });

  return normalizeSearchText(
    [
      paper.title,
      paper.summary,
      paper.takeaway,
      paper.arxivId,
      ...(paper.authors ?? []),
      ...(paper.tags ?? []),
      ...islandTerms,
    ].join(' '),
  );
}

export function buildCatalogIndex(catalog) {
  const papers = Array.isArray(catalog?.papers) ? catalog.papers : [];
  const islands = Array.isArray(catalog?.islands) ? catalog.islands : [];
  const islandById = new Map(islands.map((island) => [island.id, island]));
  const paperIds = new Set(papers.map((paper) => paper.id));
  const citedBy = new Map(papers.map((paper) => [paper.id, []]));
  let edgeCount = 0;

  for (const paper of papers) {
    for (const citedId of new Set(paper.cites ?? [])) {
      if (citedId === paper.id || !paperIds.has(citedId)) continue;
      citedBy.get(citedId).push(paper.id);
      edgeCount += 1;
    }
  }

  return {
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    taxonomyRevision: catalog.taxonomyRevision,
    catalogDigest: catalogDigest(catalog),
    paperCount: papers.length,
    edgeCount,
    papers: Object.fromEntries(
      papers.map((paper) => {
        const incoming = citedBy.get(paper.id) ?? [];
        return [
          paper.id,
          {
            citedBy: incoming,
            incomingCitationCount: incoming.length,
            searchText: paperSearchText(paper, islandById),
          },
        ];
      }),
    ),
  };
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * Validate both freshness and structure. A stale or damaged generated file is
 * never allowed to influence the public pages: callers fall back to an index
 * rebuilt from landscape.json.
 */
export function validateCatalogIndex(catalog, candidate) {
  const errors = [];
  const papers = Array.isArray(catalog?.papers) ? catalog.papers : [];
  const islands = Array.isArray(catalog?.islands) ? catalog.islands : [];
  const islandById = new Map(islands.map((island) => [island.id, island]));
  const paperIds = new Set(papers.map((paper) => paper.id));
  const expectedCitedBy = new Map(papers.map((paper) => [paper.id, []]));
  let expectedEdgeCount = 0;

  for (const paper of papers) {
    for (const citedId of new Set(paper.cites ?? [])) {
      if (citedId === paper.id || !paperIds.has(citedId)) continue;
      expectedCitedBy.get(citedId).push(paper.id);
      expectedEdgeCount += 1;
    }
  }

  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['catalog index is not an object'] };
  }
  if (candidate.schemaVersion !== CATALOG_INDEX_SCHEMA_VERSION) {
    errors.push(
      `schema version ${String(candidate.schemaVersion)} does not match ${CATALOG_INDEX_SCHEMA_VERSION}`,
    );
  }
  if (candidate.taxonomyRevision !== catalog.taxonomyRevision) {
    errors.push('taxonomy revision does not match landscape.json');
  }

  const expectedDigest = catalogDigest(catalog);
  if (candidate.catalogDigest !== expectedDigest) {
    errors.push('catalog digest does not match landscape.json');
  }
  if (candidate.paperCount !== papers.length) {
    errors.push(
      `paper count ${String(candidate.paperCount)} does not match ${papers.length}`,
    );
  }
  if (!candidate.papers || typeof candidate.papers !== 'object') {
    errors.push('papers index is missing');
    return { ok: false, errors };
  }

  const indexedIds = Object.keys(candidate.papers);
  if (
    indexedIds.length !== paperIds.size ||
    indexedIds.some((paperId) => !paperIds.has(paperId))
  ) {
    errors.push('papers index IDs do not match the catalog');
  }

  let indexedEdgeCount = 0;
  for (const paper of papers) {
    const entry = candidate.papers[paper.id];
    if (!entry || typeof entry !== 'object') {
      errors.push(`missing index entry for ${paper.id}`);
      continue;
    }
    if (!isStringArray(entry.citedBy)) {
      errors.push(`citedBy for ${paper.id} is not a string array`);
    } else {
      indexedEdgeCount += entry.citedBy.length;
      if (
        new Set(entry.citedBy).size !== entry.citedBy.length ||
        entry.citedBy.some((citingId) => !paperIds.has(citingId))
      ) {
        errors.push(
          `citedBy for ${paper.id} contains invalid or duplicate IDs`,
        );
      }
      if (entry.incomingCitationCount !== entry.citedBy.length) {
        errors.push(`incoming citation count is inconsistent for ${paper.id}`);
      }
      const expectedIncoming = expectedCitedBy.get(paper.id) ?? [];
      if (
        entry.citedBy.length !== expectedIncoming.length ||
        entry.citedBy.some(
          (citingId, index) => citingId !== expectedIncoming[index],
        )
      ) {
        errors.push(`citedBy does not match the catalog for ${paper.id}`);
      }
    }
    if (entry.searchText !== paperSearchText(paper, islandById)) {
      errors.push(`search text does not match the catalog for ${paper.id}`);
    }
  }

  if (
    candidate.edgeCount !== indexedEdgeCount ||
    candidate.edgeCount !== expectedEdgeCount
  ) {
    errors.push(
      `edge count ${String(candidate.edgeCount)} does not match ${expectedEdgeCount}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

export function resolveCatalogIndex(catalog, candidate, options = {}) {
  const validation = validateCatalogIndex(catalog, candidate);
  if (validation.ok) {
    return { index: candidate, source: 'generated', errors: [] };
  }

  if (typeof options.warn === 'function') {
    options.warn(
      `Generated catalog index is stale or invalid; rebuilt safely in memory (${validation.errors.join('; ')}).`,
    );
  }
  return {
    index: buildCatalogIndex(catalog),
    source: 'fallback',
    errors: validation.errors,
  };
}
