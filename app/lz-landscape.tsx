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

type Island = (typeof landscape.islands)[number];
type Paper = (typeof landscape.papers)[number];
type ViewMode = 'map' | 'list';
type MapPoint = { x: number; y: number };
type LabelClearZone = {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};
type MapGeometry = {
  width: number;
  height: number;
  labelClearZones: LabelClearZone[];
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

const islandById = new Map(landscape.islands.map((island) => [island.id, island]));

const NODE_DIAMETER_PX: Record<Paper['role'], number> = {
  observation: 48,
  explanation: 34,
  constraint: 34,
  diagnostic: 34,
  adjacent: 34,
};

const NODE_HALO_PX: Record<Paper['role'], number> = {
  observation: 12,
  explanation: 5,
  constraint: 5,
  diagnostic: 5,
  adjacent: 5,
};

const NODE_ACTIVE_SCALE = 1.12;
const LABEL_GAP_PX = 4;
const POSITION_EPSILON = 0.02;

function roundMapValue(value: number) {
  return Math.round(value * 1000) / 1000;
}

function sameMapGeometry(previous: MapGeometry | null, next: MapGeometry) {
  if (
    !previous ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.labelClearZones.length !== next.labelClearZones.length
  ) {
    return false;
  }

  return previous.labelClearZones.every((zone, index) => {
    const nextZone = next.labelClearZones[index];
    return (
      zone.id === nextZone.id &&
      zone.left === nextZone.left &&
      zone.right === nextZone.right &&
      zone.top === nextZone.top &&
      zone.bottom === nextZone.bottom
    );
  });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function uniqueValues(values: number[]) {
  return [...new Set(values.map((value) => roundMapValue(value)))];
}

function paperMapPosition(
  paper: Paper,
  geometry: MapGeometry | null,
): MapPoint {
  const semanticPosition = { x: paper.x, y: paper.y };
  if (!geometry || geometry.width <= 0 || geometry.height <= 0) {
    return semanticPosition;
  }

  const visualRadius =
    (NODE_DIAMETER_PX[paper.role] / 2 + NODE_HALO_PX[paper.role]) *
      NODE_ACTIVE_SCALE +
    LABEL_GAP_PX;
  const clearanceX = (visualRadius / geometry.width) * 100;
  const clearanceY = (visualRadius / geometry.height) * 100;
  const expandedZones = geometry.labelClearZones.map((zone) => ({
    left: zone.left - clearanceX,
    right: zone.right + clearanceX,
    top: zone.top - clearanceY,
    bottom: zone.bottom + clearanceY,
  }));
  const isClear = (point: MapPoint) =>
    expandedZones.every(
      (zone) =>
        point.x <= zone.left ||
        point.x >= zone.right ||
        point.y <= zone.top ||
        point.y >= zone.bottom,
    );

  if (isClear(semanticPosition)) return semanticPosition;

  const minimumX = clearanceX;
  const maximumX = 100 - clearanceX;
  const minimumY = clearanceY;
  const maximumY = 100 - clearanceY;
  const xCandidates = uniqueValues([
    clamp(paper.x, minimumX, maximumX),
    ...expandedZones.flatMap((zone) => [
      clamp(zone.left - POSITION_EPSILON, minimumX, maximumX),
      clamp(zone.right + POSITION_EPSILON, minimumX, maximumX),
    ]),
  ]);
  const yCandidates = uniqueValues([
    clamp(paper.y, minimumY, maximumY),
    ...expandedZones.flatMap((zone) => [
      clamp(zone.top - POSITION_EPSILON, minimumY, maximumY),
      clamp(zone.bottom + POSITION_EPSILON, minimumY, maximumY),
    ]),
  ]);

  let closestPoint: MapPoint | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const x of xCandidates) {
    for (const y of yCandidates) {
      const candidate = { x, y };
      if (!isClear(candidate)) continue;
      const horizontalDistance = ((x - paper.x) / 100) * geometry.width;
      const verticalDistance = ((y - paper.y) / 100) * geometry.height;
      const distance = horizontalDistance ** 2 + verticalDistance ** 2;
      if (distance < closestDistance) {
        closestPoint = candidate;
        closestDistance = distance;
      }
    }
  }

  return closestPoint ?? semanticPosition;
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

export function LzLandscape() {
  const [query, setQuery] = useState('');
  const [activeIsland, setActiveIsland] = useState('all');
  const [selectedId, setSelectedId] = useState(landscape.papers[0].id);
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [mapGeometry, setMapGeometry] = useState<MapGeometry | null>(null);
  const mapCanvasRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (viewMode !== 'map') return;
    const canvas = mapCanvasRef.current;
    if (!canvas) return;

    const labels = Array.from(
      canvas.querySelectorAll<HTMLElement>('[data-island-label]'),
    );
    const measureMap = () => {
      const canvasBounds = canvas.getBoundingClientRect();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!canvasBounds.width || !canvasBounds.height || !width || !height) {
        return;
      }

      const labelClearZones = labels.flatMap((label) => {
        const id = label.dataset.islandLabel;
        if (!id) return [];
        const bounds = label.getBoundingClientRect();
        return [
          {
            id,
            left: roundMapValue(
              ((bounds.left - canvasBounds.left) / canvasBounds.width) * 100,
            ),
            right: roundMapValue(
              ((bounds.right - canvasBounds.left) / canvasBounds.width) * 100,
            ),
            top: roundMapValue(
              ((bounds.top - canvasBounds.top) / canvasBounds.height) * 100,
            ),
            bottom: roundMapValue(
              ((bounds.bottom - canvasBounds.top) / canvasBounds.height) * 100,
            ),
          },
        ];
      });
      const nextGeometry = { width, height, labelClearZones };
      setMapGeometry((previous) =>
        sameMapGeometry(previous, nextGeometry) ? previous : nextGeometry,
      );
    };

    measureMap();
    const observer = new ResizeObserver(measureMap);
    observer.observe(canvas);
    for (const label of labels) observer.observe(label);

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
                enum: [
                  'all',
                  ...landscape.islands.map((island) => island.id),
                ],
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
            const nextIsland = values.island === undefined ? 'all' : values.island;
            if (typeof nextQuery !== 'string' || nextQuery.length > 160) {
              throw new Error(
                'query must be a string no longer than 160 characters.',
              );
            }
            if (
              typeof nextIsland !== 'string' ||
              !allowedIslands.has(nextIsland)
            ) {
              throw new Error('island must be one of the published island IDs.');
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

  const paperPositions = useMemo(
    () =>
      new Map(
        landscape.papers.map((paper) => [
          paper.id,
          paperMapPosition(paper, mapGeometry),
        ]),
      ),
    [mapGeometry],
  );

  const visibleIds = new Set(visiblePapers.map((paper) => paper.id));
  const selectedPaper =
    visiblePapers.find((paper) => paper.id === selectedId) ??
    visiblePapers[0] ??
    landscape.papers.find((paper) => paper.id === selectedId) ??
    landscape.papers[0];
  const selectedIsland = islandById.get(selectedPaper.primaryIsland);
  const selectedPosition =
    paperPositions.get(selectedPaper.id) ?? selectedPaper;
  const selectedRelatedIds = [
    ...new Set([
      ...selectedPaper.related,
      ...landscape.papers
        .filter((paper) => paper.related.includes(selectedPaper.id))
        .map((paper) => paper.id),
    ]),
  ];

  function selectPaper(id: string) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('paper', id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function chooseIsland(id: string) {
    setActiveIsland(id);
    const firstMatch = filterPapers(query, id)[0];
    if (firstMatch) selectPaper(firstMatch.id);
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
              const method = document.querySelector<HTMLDetailsElement>('#method');
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
          <div className="intro">
            <p className="eyebrow">The landscape · September 2026</p>
            <h1>One event, many possible worlds.</h1>
            <p>
              A living map of papers responding to LZ&apos;s isolated 248 keV
              nuclear-recoil candidate.
            </p>
          </div>

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
              island labels, and neutral summaries.
            </p>
            <p>
              Existing circles stay fixed during daily updates. Every proposed
              addition is reviewed in a pull request before it appears here.
              Distance expresses shared ideas, not evidence or consensus.
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
                  {selectedRelatedIds.map((relatedId) => {
                    const related = landscape.papers.find(
                      (paper) => paper.id === relatedId,
                    );
                    if (!related || !visibleIds.has(related.id)) return null;
                    const relatedPosition =
                      paperPositions.get(related.id) ?? related;
                    return (
                      <line
                        key={related.id}
                        className="relation-line"
                        x1={selectedPosition.x}
                        y1={selectedPosition.y}
                        x2={relatedPosition.x}
                        y2={relatedPosition.y}
                      />
                    );
                  })}
                </svg>

                {landscape.islands.map((island) => {
                  const hasVisiblePaper = landscape.papers.some(
                    (paper) =>
                      visibleIds.has(paper.id) &&
                      paper.islands.includes(island.id),
                  );
                  return (
                    <div
                      className={`island ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                      key={island.id}
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
                      <div className="island-ring island-ring--outer" />
                      <div className="island-ring island-ring--inner" />
                      <div className="island-fill" />
                      <div
                        className="island-label"
                        data-island-label={island.id}
                      >
                        <span>{island.label}</span>
                        <small>{island.kicker}</small>
                      </div>
                    </div>
                  );
                })}

                {landscape.papers.map((paper, index) => {
                  const island = islandById.get(paper.primaryIsland) as Island;
                  const isVisible = visibleIds.has(paper.id);
                  const isSelected = selectedPaper.id === paper.id;
                  const position = paperPositions.get(paper.id) ?? paper;
                  return (
                    <button
                      type="button"
                      key={paper.id}
                      className={`paper-node paper-node--${paper.role} ${isSelected ? 'is-selected' : ''} ${isVisible ? '' : 'is-hidden'}`}
                      style={
                        {
                          '--node-color': island.color,
                          left: `${position.x}%`,
                          top: `${position.y}%`,
                        } as React.CSSProperties
                      }
                      onClick={() => selectPaper(paper.id)}
                      aria-label={`Open ${paper.title}`}
                      aria-pressed={isSelected}
                    >
                      <span>
                        {paper.role === 'observation'
                          ? 'LZ'
                          : String(index).padStart(2, '0')}
                      </span>
                      <span className="node-tooltip">
                        <strong>{paper.title}</strong>
                        <small>{paper.authors[0]}</small>
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
                      className={selectedPaper.id === paper.id ? 'is-selected' : ''}
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
                ? 'Select a circle to reveal its closest links.'
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

          <h2>{selectedPaper.title}</h2>
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
