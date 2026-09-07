'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpenText,
  CalendarDays,
  ExternalLink,
  List,
  Map as MapIcon,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import landscape from '@/data/landscape.json';
import { createStaticMapLayout } from '@/lib/static-map-layout';

type Island = (typeof landscape.islands)[number];
type Paper = (typeof landscape.papers)[number];
type ViewMode = 'map' | 'list';
type MapPoint = { x: number; y: number };
type LabelGeometry = {
  id: string;
  width: number;
  height: number;
};
type PaperGeometry = {
  id: string;
  diameter: number;
};
type MapGeometry = {
  width: number;
  height: number;
  labels: LabelGeometry[];
  papers: PaperGeometry[];
};

type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

const islandById = new Map(
  landscape.islands.map((island) => [island.id, island]),
);
const paperById = new Map(landscape.papers.map((paper) => [paper.id, paper]));

const NODE_HALO_PX: Record<Paper['role'], number> = {
  observation: 4,
  explanation: 4,
  constraint: 4,
  diagnostic: 4,
  adjacent: 4,
};

const NODE_ACTIVE_SCALE = 1.1;

function roundMapValue(value: number) {
  return Math.round(value * 1000) / 1000;
}

function sameMapGeometry(previous: MapGeometry | null, next: MapGeometry) {
  if (
    !previous ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.labels.length !== next.labels.length ||
    previous.papers.length !== next.papers.length
  ) {
    return false;
  }

  const labelsMatch = previous.labels.every((label, index) => {
    const nextLabel = next.labels[index];
    return (
      label.id === nextLabel.id &&
      label.width === nextLabel.width &&
      label.height === nextLabel.height
    );
  });
  const papersMatch = previous.papers.every((paper, index) => {
    const nextPaper = next.papers[index];
    return paper.id === nextPaper.id && paper.diameter === nextPaper.diameter;
  });
  return labelsMatch && papersMatch;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00Z`));
}

function roleLabel(role: Paper['role']) {
  const labels: Record<Paper['role'], string> = {
    observation: 'Source result',
    explanation: 'Interpretation',
    constraint: 'Constraint',
    diagnostic: 'Discriminant',
    adjacent: 'Adjacent work',
  };
  return labels[role];
}

const MAX_TOOLTIP_AUTHORS = 4;
const MAX_TOOLTIP_AUTHOR_CHARACTERS = 80;
const MAX_VISIBLE_CITATION_ROWS = 5;

function tooltipAuthorLabel(authors: readonly string[]) {
  const names = authors.map((author) => author.trim()).filter(Boolean);
  const collaboration = names.find((author) =>
    /\b(?:collaboration|consortium)\b/i.test(author),
  );
  if (collaboration) return collaboration;
  if (!names.length) return null;
  if (names.length === 1) return names[0];

  const fullAuthorList = names.join(', ');
  if (
    names.length === 2 ||
    (names.length <= MAX_TOOLTIP_AUTHORS &&
      fullAuthorList.length <= MAX_TOOLTIP_AUTHOR_CHARACTERS)
  ) {
    return fullAuthorList;
  }
  return `${names[0]} et al.`;
}

function filterPapers(query: string, islandId: string) {
  const normalized = query.trim().toLowerCase();
  return landscape.papers.filter((paper) => {
    const inIsland = islandId === 'all' || paper.islands.includes(islandId);
    const haystack = [
      paper.title,
      paper.summary,
      paper.takeaway,
      paper.arxivId,
      ...paper.authors,
      ...paper.tags,
    ]
      .join(' ')
      .toLowerCase();
    return inIsland && (!normalized || haystack.includes(normalized));
  });
}

type CitationGroupProps = {
  title: string;
  papers: Paper[];
  relationship: 'cites' | 'cited-by';
  onSelect: (id: string) => void;
};

function CitationRows({
  papers,
  relationship,
  onSelect,
}: Omit<CitationGroupProps, 'title'>) {
  return (
    <ul className="citation-list">
      {papers.map((paper) => {
        const authorLabel = tooltipAuthorLabel(paper.authors);
        const relationshipLabel =
          relationship === 'cites'
            ? 'cited by this paper'
            : 'which cites this paper';
        return (
          <li key={paper.id}>
            <button
              type="button"
              onClick={() => onSelect(paper.id)}
              aria-label={`Select ${paper.title}, ${relationshipLabel}`}
            >
              <small>
                {authorLabel ? `${authorLabel} · ` : ''}
                {paper.published.slice(0, 4)}
              </small>
              <span>{paper.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CitationGroup({
  title,
  papers,
  relationship,
  onSelect,
}: CitationGroupProps) {
  const visiblePapers = papers.slice(0, MAX_VISIBLE_CITATION_ROWS);
  const remainingPapers = papers.slice(MAX_VISIBLE_CITATION_ROWS);
  return (
    <section className="citation-group">
      <div className="citation-group-heading">
        <h4>{title}</h4>
        <span>{papers.length}</span>
      </div>
      {papers.length ? (
        <>
          <CitationRows
            papers={visiblePapers}
            relationship={relationship}
            onSelect={onSelect}
          />
          {remainingPapers.length > 0 && (
            <details className="citation-more">
              <summary>Show {remainingPapers.length} more</summary>
              <CitationRows
                papers={remainingPapers}
                relationship={relationship}
                onSelect={onSelect}
              />
            </details>
          )}
        </>
      ) : (
        <p className="citation-empty">None among papers currently mapped.</p>
      )}
    </section>
  );
}

export function LzLandscape() {
  const [query, setQuery] = useState('');
  const [activeIsland, setActiveIsland] = useState('all');
  const [selectedId, setSelectedId] = useState(landscape.papers[0].id);
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [mapGeometry, setMapGeometry] = useState<MapGeometry | null>(null);
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const focusDetailAfterCitation = useRef(false);

  useLayoutEffect(() => {
    if (viewMode !== 'map') return;
    const canvas = mapCanvasRef.current;
    if (!canvas) return;

    const labels = Array.from(
      canvas.querySelectorAll<HTMLElement>('[data-island-label]'),
    );
    const paperNodes = Array.from(
      canvas.querySelectorAll<HTMLElement>('[data-paper-node]'),
    );
    const measureMap = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;

      const labelGeometry = labels.flatMap((label) => {
        const id = label.dataset.islandLabel;
        if (!id) return [];
        return [
          {
            id,
            width: roundMapValue(label.offsetWidth),
            height: roundMapValue(label.offsetHeight),
          },
        ];
      });
      const paperGeometry = paperNodes.flatMap((paperNode) => {
        const id = paperNode.dataset.paperNode;
        if (!id) return [];
        return [
          {
            id,
            diameter: roundMapValue(paperNode.offsetWidth),
          },
        ];
      });
      const nextGeometry = {
        width,
        height,
        labels: labelGeometry,
        papers: paperGeometry,
      };
      setMapGeometry((previous) =>
        sameMapGeometry(previous, nextGeometry) ? previous : nextGeometry,
      );
    };

    measureMap();
    const observer = new ResizeObserver(measureMap);
    observer.observe(canvas);
    for (const label of labels) observer.observe(label);
    for (const paperNode of paperNodes) observer.observe(paperNode);

    let isCurrent = true;
    void document.fonts.ready.then(() => {
      if (isCurrent) measureMap();
    });
    return () => {
      isCurrent = false;
      observer.disconnect();
    };
  }, [viewMode]);

  useEffect(() => {
    const paperId = new URLSearchParams(window.location.search).get('paper');
    if (paperId && landscape.papers.some((paper) => paper.id === paperId)) {
      let isCurrent = true;
      queueMicrotask(() => {
        if (isCurrent) setSelectedId(paperId);
      });
      return () => {
        isCurrent = false;
      };
    }
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const allowedIslands = new Set([
      'all',
      ...landscape.islands.map((island) => island.id),
    ]);
    const registrations = [
      context.registerTool(
        {
          name: 'search_lz_papers',
          title: 'Search LZ papers',
          description:
            'Filter the visible LZ literature by a text query and optional idea-island, then show the matching list.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Title, author, arXiv ID, mechanism, or concept.',
              },
              island: {
                type: 'string',
                enum: ['all', ...landscape.islands.map((island) => island.id)],
                description: 'Optional idea-island ID.',
              },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Expected an object with query and/or island.');
            }
            const values = input as Record<string, unknown>;
            const nextQuery = values.query === undefined ? '' : values.query;
            const nextIsland =
              values.island === undefined ? 'all' : values.island;
            if (typeof nextQuery !== 'string' || nextQuery.length > 160) {
              throw new Error(
                'query must be a string no longer than 160 characters.',
              );
            }
            if (
              typeof nextIsland !== 'string' ||
              !allowedIslands.has(nextIsland)
            ) {
              throw new Error(
                'island must be one of the published island IDs.',
              );
            }
            const matches = filterPapers(nextQuery, nextIsland);
            setQuery(nextQuery);
            setActiveIsland(nextIsland);
            setViewMode('list');
            if (matches[0]) setSelectedId(matches[0].id);
            return {
              count: matches.length,
              papers: matches.slice(0, 12).map((paper) => ({
                arxiv_id: paper.id,
                title: paper.title,
                role: paper.role,
              })),
            };
          },
        },
        { signal: lifecycle.signal },
      ),
      context.registerTool(
        {
          name: 'show_lz_paper',
          title: 'Show an LZ paper',
          description:
            'Select one paper by canonical arXiv ID and display its details in the visible paper panel.',
          inputSchema: {
            type: 'object',
            properties: { arxiv_id: { type: 'string' } },
            required: ['arxiv_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Expected an object with arxiv_id.');
            }
            const identifier = (input as Record<string, unknown>).arxiv_id;
            if (typeof identifier !== 'string') {
              throw new Error('arxiv_id must be a string.');
            }
            const paper = landscape.papers.find(
              (item) => item.id === identifier,
            );
            if (!paper) {
              throw new Error(`No paper with arXiv ID ${identifier}.`);
            }
            setSelectedId(paper.id);
            setActiveIsland('all');
            const url = new URL(window.location.href);
            url.searchParams.set('paper', paper.id);
            window.history.replaceState(
              null,
              '',
              `${url.pathname}${url.search}${url.hash}`,
            );
            return {
              arxiv_id: paper.id,
              title: paper.title,
              primary_island: paper.primaryIsland,
              url: paper.url,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ];

    for (const registration of registrations) {
      void Promise.resolve(registration).catch(() => undefined);
    }
    return () => lifecycle.abort();
  }, []);

  const visiblePapers = useMemo(
    () => filterPapers(query, activeIsland),
    [activeIsland, query],
  );

  const staticLayout = useMemo(() => {
    const paperPositions = new Map<string, MapPoint>(
      landscape.papers.map((paper) => [paper.id, { x: paper.x, y: paper.y }]),
    );
    const labelPositions = new Map<string, MapPoint>(
      landscape.islands.map((island) => [
        island.id,
        {
          x: island.x + island.width * 0.1,
          y: island.y + island.height * 0.1,
        },
      ]),
    );
    if (!mapGeometry?.width || !mapGeometry.height) {
      return { papers: paperPositions, labels: labelPositions };
    }

    const labelGeometryById = new Map(
      mapGeometry.labels.map((label) => [label.id, label]),
    );
    const paperGeometryById = new Map(
      mapGeometry.papers.map((paper) => [paper.id, paper]),
    );
    const relaxedLayout = createStaticMapLayout(
      mapGeometry.width,
      mapGeometry.height,
      landscape.papers.map((paper) => ({
        id: paper.id,
        x: (paper.x / 100) * mapGeometry.width,
        y: (paper.y / 100) * mapGeometry.height,
        radius:
          ((paperGeometryById.get(paper.id)?.diameter ??
            (paper.role === 'observation' ? 44 : 32)) /
            2) *
            NODE_ACTIVE_SCALE +
          NODE_HALO_PX[paper.role],
        mobility: paper.role === 'observation' ? 0.38 : 1,
        anchorStrength: paper.role === 'observation' ? 0.085 : 0.042,
        maxDisplacement:
          paper.role === 'observation'
            ? Math.min(30, mapGeometry.width * 0.075)
            : Math.min(62, Math.max(46, mapGeometry.width * 0.14)),
      })),
      landscape.islands.flatMap((island) => {
        const geometry = labelGeometryById.get(island.id);
        if (!geometry) return [];
        return [
          {
            id: island.id,
            x:
              ((island.x + island.width * 0.1) / 100) * mapGeometry.width +
              geometry.width / 2,
            y:
              ((island.y + island.height * 0.1) / 100) * mapGeometry.height +
              geometry.height / 2,
            width: geometry.width,
            height: geometry.height,
            maxDisplacement: Math.min(
              34,
              Math.max(20, mapGeometry.width * 0.065),
            ),
          },
        ];
      }),
    );

    return {
      papers: new Map(
        [...relaxedLayout.papers].map(([id, point]) => [
          id,
          {
            x: roundMapValue((point.x / mapGeometry.width) * 100),
            y: roundMapValue((point.y / mapGeometry.height) * 100),
          },
        ]),
      ),
      labels: new Map(
        [...relaxedLayout.labels].map(([id, point]) => [
          id,
          {
            x: roundMapValue((point.x / mapGeometry.width) * 100),
            y: roundMapValue((point.y / mapGeometry.height) * 100),
          },
        ]),
      ),
    };
  }, [mapGeometry]);

  const paperPositions = staticLayout.papers;
  const labelPositions = staticLayout.labels;

  const visibleIds = new Set(visiblePapers.map((paper) => paper.id));
  const selectedPaper =
    visiblePapers.find((paper) => paper.id === selectedId) ??
    visiblePapers[0] ??
    landscape.papers.find((paper) => paper.id === selectedId) ??
    landscape.papers[0];
  const selectedIsland = islandById.get(selectedPaper.primaryIsland);
  const selectedCites = selectedPaper.cites.flatMap((paperId) => {
    const paper = paperById.get(paperId);
    return paper ? [paper] : [];
  });
  const selectedCitedBy = landscape.papers.filter((paper) =>
    paper.cites.includes(selectedPaper.id),
  );

  useEffect(() => {
    if (!focusDetailAfterCitation.current) return;
    focusDetailAfterCitation.current = false;
    detailTitleRef.current?.focus();
  }, [selectedPaper.id]);

  function selectPaper(id: string) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('paper', id);
    window.history.replaceState(
      null,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  function chooseIsland(id: string) {
    setActiveIsland(id);
    const firstMatch = filterPapers(query, id)[0];
    if (firstMatch) selectPaper(firstMatch.id);
  }

  function selectCitationPaper(id: string) {
    focusDetailAfterCitation.current = true;
    setQuery('');
    setActiveIsland('all');
    selectPaper(id);
  }

  function resetMap() {
    setZoom(1);
    setQuery('');
    setActiveIsland('all');
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="LZ Paper Map home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>
            <strong>LZ Paper Map</strong>
            <small>High-recoil literature</small>
          </span>
        </a>

        <div className="topbar-meta">
          <span>{landscape.papers.length} papers</span>
          <span className="meta-divider" aria-hidden="true" />
          <span>Updated {dateLabel(landscape.updatedAt)}</span>
          <a
            href="#method"
            onClick={() => {
              const method =
                document.querySelector<HTMLDetailsElement>('#method');
              if (method) method.open = true;
            }}
          >
            Method
          </a>
          <a
            href="https://arxiv.org/abs/2609.02823"
            target="_blank"
            rel="noreferrer"
          >
            LZ result <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </header>

      <section className="workspace" id="top">
        <aside className="sidebar" aria-label="Map controls">
          <label className="search-field" htmlFor="paper-search">
            <span className="sr-only">Search papers</span>
            <Search aria-hidden="true" />
            <Input
              id="paper-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, author, idea…"
            />
          </label>

          <nav className="island-nav" aria-label="Filter by explanation">
            <p className="nav-label">Ideas</p>
            <button
              type="button"
              className={activeIsland === 'all' ? 'is-active' : ''}
              onClick={() => chooseIsland('all')}
            >
              <span className="island-swatch island-swatch--all" />
              <span>All papers</span>
              <small>{landscape.papers.length}</small>
            </button>
            {landscape.islands.map((island) => {
              const count = landscape.papers.filter((paper) =>
                paper.islands.includes(island.id),
              ).length;
              return (
                <button
                  type="button"
                  key={island.id}
                  className={activeIsland === island.id ? 'is-active' : ''}
                  onClick={() => chooseIsland(island.id)}
                >
                  <span
                    className="island-swatch"
                    style={{ backgroundColor: island.color }}
                  />
                  <span>{island.shortLabel}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </nav>

          <div className="reading-key">
            <p className="nav-label">How to read the map</p>
            <p>
              Nearby circles share mechanisms, particles, or phenomenology. A
              paper may belong to more than one island.
            </p>
            <div>
              <span className="key-node key-node--source" />
              <span>Experimental result</span>
            </div>
            <div>
              <span className="key-node" />
              <span>Interpretation or follow-up</span>
            </div>
          </div>

          <details className="method-summary" id="method">
            <summary>Method &amp; caveats</summary>
            <p>
              arXiv supplies titles, authors, dates, IDs, and links. A
              schema-constrained OpenAI call proposes only relevance, existing
              island labels, and neutral summaries. Citation lineage is checked
              separately against paper reference lists.
            </p>
            <p>
              The layout settles deterministically around the curated idea
              coordinates, with small local adjustments when papers are added.
              Every proposed addition is reviewed in a pull request before it
              appears here. Distance expresses shared ideas, not evidence or
              consensus.
            </p>
          </details>
        </aside>

        <section className="map-panel" aria-label="Paper landscape">
          <div className="map-toolbar">
            <div>
              <span className="live-dot" />
              <span>
                Showing {visiblePapers.length} of {landscape.papers.length}
              </span>
            </div>
            <div className="map-tools">
              <div className="view-toggle" aria-label="Choose a view">
                <Button
                  variant={viewMode === 'map' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={viewMode === 'map'}
                  onClick={() => setViewMode('map')}
                >
                  <MapIcon /> Map
                </Button>
                <Button
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={viewMode === 'list'}
                  onClick={() => setViewMode('list')}
                >
                  <List /> List
                </Button>
              </div>
              {viewMode === 'map' && (
                <div className="zoom-controls" aria-label="Map zoom controls">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Zoom out"
                    disabled={zoom <= 0.86}
                    onClick={() =>
                      setZoom((value) => Math.max(0.85, value - 0.15))
                    }
                  >
                    <Minus />
                  </Button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Zoom in"
                    disabled={zoom >= 1.44}
                    onClick={() =>
                      setZoom((value) => Math.min(1.45, value + 0.15))
                    }
                  >
                    <Plus />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reset map"
                    onClick={resetMap}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {viewMode === 'map' ? (
            <div className="map-viewport">
              <div
                className="map-canvas"
                ref={mapCanvasRef}
                style={{ transform: `scale(${zoom})` }}
              >
                <svg
                  className="map-contours"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <pattern
                      id="grid"
                      width="3.2"
                      height="4.8"
                      patternUnits="userSpaceOnUse"
                    >
                      <path d="M 3.2 0 L 0 0 0 4.8" fill="none" />
                    </pattern>
                  </defs>
                  <rect width="100" height="100" fill="url(#grid)" />
                </svg>

                {landscape.islands.map((island) => {
                  if (island.id === 'observation') return null;
                  const hasVisiblePaper = landscape.papers.some(
                    (paper) =>
                      visibleIds.has(paper.id) &&
                      paper.islands.includes(island.id),
                  );
                  return (
                    <div
                      className={`island ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                      key={`island-${island.id}`}
                      aria-hidden="true"
                      style={
                        {
                          '--island-color': island.color,
                          left: `${island.x}%`,
                          top: `${island.y}%`,
                          width: `${island.width}%`,
                          height: `${island.height}%`,
                        } as React.CSSProperties
                      }
                    >
                      <div className="island-fill" />
                    </div>
                  );
                })}

                {landscape.islands.map((island) => {
                  const hasVisiblePaper = landscape.papers.some(
                    (paper) =>
                      visibleIds.has(paper.id) &&
                      paper.islands.includes(island.id),
                  );
                  const position = labelPositions.get(island.id) ?? {
                    x: island.x + island.width * 0.1,
                    y: island.y + island.height * 0.1,
                  };
                  return (
                    <div
                      className={`island-label ${mapGeometry ? '' : 'is-measuring'} ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                      data-island-label={island.id}
                      aria-hidden={!mapGeometry || !hasVisiblePaper}
                      key={`label-${island.id}`}
                      style={
                        {
                          '--island-color': island.color,
                          left: `${position.x}%`,
                          top: `${position.y}%`,
                        } as React.CSSProperties
                      }
                    >
                      <span>{island.label}</span>
                      <small>{island.kicker}</small>
                    </div>
                  );
                })}

                {landscape.papers.map((paper, index) => {
                  const island = islandById.get(paper.primaryIsland) as Island;
                  const isVisible = visibleIds.has(paper.id);
                  const isSelected = selectedPaper.id === paper.id;
                  const position = paperPositions.get(paper.id) ?? paper;
                  const tooltipEdgeThreshold = mapGeometry?.width
                    ? (120 / mapGeometry.width) * 100
                    : 18;
                  const tooltipEdgeClass =
                    position.x < tooltipEdgeThreshold
                      ? 'paper-node--tooltip-right'
                      : position.x > 100 - tooltipEdgeThreshold
                        ? 'paper-node--tooltip-left'
                        : '';
                  const tooltipVerticalThreshold = mapGeometry?.height
                    ? (130 / mapGeometry.height) * 100
                    : 24;
                  const tooltipVerticalClass =
                    position.y < tooltipVerticalThreshold
                      ? 'paper-node--tooltip-below'
                      : '';
                  const authorLabel = tooltipAuthorLabel(paper.authors);
                  const tooltipAuthorId = `paper-authors-${paper.id}`;
                  return (
                    <button
                      type="button"
                      key={paper.id}
                      className={`paper-node paper-node--${paper.role} ${tooltipEdgeClass} ${tooltipVerticalClass} ${isSelected ? 'is-selected' : ''} ${isVisible ? '' : 'is-hidden'}`}
                      style={
                        {
                          '--node-color': island.color,
                          left: `${position.x}%`,
                          top: `${position.y}%`,
                        } as React.CSSProperties
                      }
                      onClick={() => selectPaper(paper.id)}
                      data-paper-node={paper.id}
                      aria-label={`Open ${paper.title}`}
                      aria-describedby={
                        authorLabel ? tooltipAuthorId : undefined
                      }
                      aria-pressed={isSelected}
                    >
                      <span>
                        {paper.role === 'observation'
                          ? 'LZ'
                          : String(index).padStart(2, '0')}
                      </span>
                      <span className="node-tooltip">
                        <strong>{paper.title}</strong>
                        {authorLabel && (
                          <small id={tooltipAuthorId}>{authorLabel}</small>
                        )}
                      </span>
                    </button>
                  );
                })}

                {visiblePapers.length === 0 && (
                  <div className="empty-map">
                    <Search aria-hidden="true" />
                    <strong>No matching papers</strong>
                    <span>Try a mechanism, author, or arXiv ID.</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="paper-list" aria-label="Paper list">
              {visiblePapers.length ? (
                visiblePapers.map((paper) => {
                  const island = islandById.get(paper.primaryIsland);
                  return (
                    <button
                      type="button"
                      key={paper.id}
                      className={
                        selectedPaper.id === paper.id ? 'is-selected' : ''
                      }
                      onClick={() => selectPaper(paper.id)}
                    >
                      <span
                        className="list-dot"
                        style={{ backgroundColor: island?.color }}
                      />
                      <span className="list-copy">
                        <small>
                          {dateLabel(paper.published)} · arXiv:{paper.arxivId}
                        </small>
                        <strong>{paper.title}</strong>
                        <span>{paper.authors.join(', ')}</span>
                      </span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  );
                })
              ) : (
                <div className="empty-list">
                  <Search aria-hidden="true" />
                  <strong>No matching papers</strong>
                  <span>Try a mechanism, author, or arXiv ID.</span>
                </div>
              )}
            </div>
          )}

          <footer className="map-footer">
            <span>Distance expresses shared ideas—not evidence strength.</span>
            <span>
              {viewMode === 'map'
                ? 'Citation lineage is listed in the paper details.'
                : 'Select a paper to inspect it.'}
            </span>
          </footer>
        </section>

        <aside className="paper-detail" aria-live="polite">
          <div className="detail-topline">
            <span
              className="detail-island-dot"
              style={{ backgroundColor: selectedIsland?.color }}
            />
            <span>{selectedIsland?.label}</span>
            <span className="paper-kind">{roleLabel(selectedPaper.role)}</span>
          </div>

          <h2 ref={detailTitleRef} tabIndex={-1}>
            {selectedPaper.title}
          </h2>
          <p className="authors">{selectedPaper.authors.join(', ')}</p>

          <div className="paper-facts">
            <span>
              <CalendarDays aria-hidden="true" />
              {dateLabel(selectedPaper.published)}
            </span>
            <span>
              <BookOpenText aria-hidden="true" />
              arXiv:{selectedPaper.arxivId}
            </span>
          </div>

          <section
            className="citation-lineage"
            aria-labelledby="citation-lineage-title"
          >
            <h3 id="citation-lineage-title">Citation lineage</h3>
            <CitationGroup
              title="Cites on this map"
              papers={selectedCites}
              relationship="cites"
              onSelect={selectCitationPaper}
            />
            <CitationGroup
              title="Cited by on this map"
              papers={selectedCitedBy}
              relationship="cited-by"
              onSelect={selectCitationPaper}
            />
          </section>

          <div className="takeaway-card">
            <Sparkles aria-hidden="true" />
            <div>
              <small>Why it is here</small>
              <p>{selectedPaper.takeaway}</p>
            </div>
          </div>

          <div className="summary-block">
            <p className="nav-label">Machine-assisted summary</p>
            <p>{selectedPaper.summary}</p>
          </div>

          <div className="tag-list" aria-label="Paper concepts">
            {selectedPaper.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>

          <a
            className="paper-link"
            href={selectedPaper.url}
            target="_blank"
            rel="noreferrer"
          >
            Read on arXiv
            <ExternalLink aria-hidden="true" />
          </a>

          <p className="screening-note">
            Metadata comes from arXiv. Summaries and placement are
            machine-assisted; inclusion is not endorsement or peer review.
          </p>
        </aside>
      </section>
    </main>
  );
}
