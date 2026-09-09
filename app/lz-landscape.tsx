'use client';

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable map needs a keyboard focus target so arrow and page keys can pan it. */

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
import {
  createHierarchicalMapLayout,
  type HierarchicalIslandLayout,
  type HierarchicalLayoutDiagnostics,
} from '@/lib/hierarchical-map-layout';
import {
  applyDateRangeToSearchParams,
  clampDateToBounds,
  dateRangeFromSearchParams,
  dayIndexToIsoDate,
  formatDateField,
  isFullDateRange,
  isoDateToDayIndex,
  paperInDateRange,
  parseDateField,
  publicationDateBounds,
  type PaperDateRange,
} from '@/lib/paper-date-range';

type Island = (typeof landscape.islands)[number];
type Paper = (typeof landscape.papers)[number];
type ViewMode = 'map' | 'list';
type DateEndpoint = 'from' | 'to';
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
type HierarchicalLayoutAttempt = {
  papers: Map<string, MapPoint>;
  labels: Map<string, MapPoint>;
  islands: Map<string, HierarchicalIslandLayout>;
  diagnostics: HierarchicalLayoutDiagnostics;
  errorMessage: string | null;
};
type PanGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};
type TooltipPlacement = {
  paperId: string;
  horizontal: 'center' | 'left' | 'right';
  vertical: 'above' | 'below';
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
const CATALOG_DATE_BOUNDS = publicationDateBounds(landscape.papers);
const CATALOG_FIRST_DAY = isoDateToDayIndex(CATALOG_DATE_BOUNDS.from);
const CATALOG_LAST_DAY = isoDateToDayIndex(CATALOG_DATE_BOUNDS.to);
const CATALOG_DAY_SPAN = Math.max(1, CATALOG_LAST_DAY - CATALOG_FIRST_DAY);
const PUBLICATION_DAY_COUNTS = [
  ...landscape.papers.reduce((counts, paper) => {
    const day = isoDateToDayIndex(paper.published);
    counts.set(day, (counts.get(day) ?? 0) + 1);
    return counts;
  }, new Map<number, number>()),
].sort(([first], [second]) => first - second);
const MAX_PUBLICATION_DAY_COUNT = Math.max(
  1,
  ...PUBLICATION_DAY_COUNTS.map(([, count]) => count),
);

const MAP_WORLD_WIDTH = 1160;
const MAP_WORLD_HEIGHT = 780;

function motionSafeScrollBehavior(preferred: ScrollBehavior): ScrollBehavior {
  if (
    preferred === 'smooth' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    return 'auto';
  }
  return preferred;
}
const FOLLOW_UP_DIAMETER_PX = 16;
const OBSERVATION_DIAMETER_PX = 28;
const ISLAND_PADDING_PX = 24;
const OBSERVATION_PACKING_PADDING_PX = 12;
const ISLAND_GAP_PX = 16;

const NODE_HALO_PX: Record<Paper['role'], number> = {
  observation: 5,
  explanation: 5,
  constraint: 5,
  diagnostic: 5,
  adjacent: 5,
};

const NODE_ACTIVE_SCALE = 1.12;

function islandLabelAnchor(island: Island): MapPoint {
  return {
    x: island.x + island.width * 0.5,
    y: island.y + island.height * 0.28,
  };
}

function islandPackingAnchor(island: Island): MapPoint {
  return {
    x: island.x + island.width * 0.5,
    y: island.y + island.height * 0.5,
  };
}

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

function filterPapers(
  query: string,
  islandId: string,
  dateRange: PaperDateRange = CATALOG_DATE_BOUNDS,
) {
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
    return (
      inIsland &&
      paperInDateRange(paper, dateRange) &&
      (!normalized || haystack.includes(normalized))
    );
  });
}

type CitationGroupProps = {
  title: string;
  papers: Paper[];
  relationship: 'cites' | 'cited-by';
  dateRange: PaperDateRange;
  dateRangeActive: boolean;
  onSelect: (id: string) => void;
};

function CitationRows({
  papers,
  relationship,
  dateRange,
  dateRangeActive,
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
        const isOutsideDateRange =
          dateRangeActive && !paperInDateRange(paper, dateRange);
        return (
          <li
            className={isOutsideDateRange ? 'is-outside-date-range' : ''}
            key={paper.id}
          >
            <button
              type="button"
              onClick={() => onSelect(paper.id)}
              aria-label={`Select ${paper.title}, ${relationshipLabel}${isOutsideDateRange ? ', outside the selected publication dates' : ''}`}
            >
              <small>
                <span>
                  {authorLabel ? `${authorLabel} · ` : ''}
                  {paper.published.slice(0, 4)}
                </span>
                {isOutsideDateRange && <em>Outside dates</em>}
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
  dateRange,
  dateRangeActive,
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
            dateRange={dateRange}
            dateRangeActive={dateRangeActive}
            onSelect={onSelect}
          />
          {remainingPapers.length > 0 && (
            <details className="citation-more">
              <summary>Show {remainingPapers.length} more</summary>
              <CitationRows
                papers={remainingPapers}
                relationship={relationship}
                dateRange={dateRange}
                dateRangeActive={dateRangeActive}
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
  const [dateRange, setDateRange] =
    useState<PaperDateRange>(CATALOG_DATE_BOUNDS);
  const [dateRangeHydrated, setDateRangeHydrated] = useState(false);
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [fromDateDraft, setFromDateDraft] = useState(
    formatDateField(CATALOG_DATE_BOUNDS.from),
  );
  const [toDateDraft, setToDateDraft] = useState(
    formatDateField(CATALOG_DATE_BOUNDS.to),
  );
  const [dateError, setDateError] = useState<DateEndpoint | null>(null);
  const [selectedId, setSelectedId] = useState(landscape.papers[0].id);
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [mapGeometry, setMapGeometry] = useState<MapGeometry | null>(null);
  const [mapFontsReady, setMapFontsReady] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [tooltipPlacement, setTooltipPlacement] =
    useState<TooltipPlacement | null>(null);
  const mapViewportRef = useRef<HTMLElement>(null);
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const mapFallbackButtonRef = useRef<HTMLButtonElement>(null);
  const listViewButtonRef = useRef<HTMLButtonElement>(null);
  const dateFilterRef = useRef<HTMLDivElement>(null);
  const dateFilterButtonRef = useRef<HTMLButtonElement>(null);
  const fromDateInputRef = useRef<HTMLInputElement>(null);
  const dateRangeRef = useRef(dateRange);
  const panGestureRef = useRef<PanGesture | null>(null);
  const revealedPaperRef = useRef<string | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const focusDetailAfterCitation = useRef(false);
  dateRangeRef.current = dateRange;

  useLayoutEffect(() => {
    if (viewMode !== 'map') return;
    const frame = requestAnimationFrame(() => {
      const viewport = mapViewportRef.current;
      if (!viewport) return;
      viewport.scrollTo({
        left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
        top: Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [viewMode]);

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
      if (isCurrent) {
        measureMap();
        setMapFontsReady(true);
      }
    });
    return () => {
      isCurrent = false;
      observer.disconnect();
    };
  }, [viewMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paperId = params.get('paper');
    const initialDateRange = dateRangeFromSearchParams(
      params,
      CATALOG_DATE_BOUNDS,
    );
    const requestedPaper = paperId ? paperById.get(paperId) : undefined;
    const initialVisiblePaper = filterPapers('', 'all', initialDateRange)[0];
    let isCurrent = true;
    queueMicrotask(() => {
      if (!isCurrent) return;
      if (
        requestedPaper &&
        paperInDateRange(requestedPaper, initialDateRange)
      ) {
        setSelectedId(requestedPaper.id);
      } else if (initialVisiblePaper) {
        setSelectedId(initialVisiblePaper.id);
      }
      setDateRange(initialDateRange);
      setFromDateDraft(formatDateField(initialDateRange.from));
      setToDateDraft(formatDateField(initialDateRange.to));
      setDateRangeHydrated(true);
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (!dateRangeHydrated) return;
    const url = new URL(window.location.href);
    const nextParams = applyDateRangeToSearchParams(
      url.searchParams,
      dateRange,
      CATALOG_DATE_BOUNDS,
    );
    if (nextParams.has('paper')) {
      nextParams.set('paper', selectedId);
    }
    const nextSearch = nextParams.toString();
    const nextLocation = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
    const currentLocation = `${url.pathname}${url.search}${url.hash}`;
    if (nextLocation !== currentLocation) {
      window.history.replaceState(null, '', nextLocation);
    }
  }, [dateRange, dateRangeHydrated, selectedId]);

  useEffect(() => {
    if (!dateFilterOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !dateFilterRef.current?.contains(event.target)
      ) {
        setDateFilterOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setDateFilterOpen(false);
      dateFilterButtonRef.current?.focus();
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [dateFilterOpen]);

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
            const matches = filterPapers(
              nextQuery,
              nextIsland,
              dateRangeRef.current,
            );
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
            if (!paperInDateRange(paper, dateRangeRef.current)) {
              setDateRange(CATALOG_DATE_BOUNDS);
              setFromDateDraft(formatDateField(CATALOG_DATE_BOUNDS.from));
              setToDateDraft(formatDateField(CATALOG_DATE_BOUNDS.to));
              setDateError(null);
            }
            setQuery('');
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
    () => filterPapers(query, activeIsland, dateRange),
    [activeIsland, dateRange, query],
  );
  const dateRangeActive = !isFullDateRange(dateRange, CATALOG_DATE_BOUNDS);
  const dateRangeFromDay = isoDateToDayIndex(dateRange.from);
  const dateRangeToDay = isoDateToDayIndex(dateRange.to);
  const dateRangeFromPercent =
    ((dateRangeFromDay - CATALOG_FIRST_DAY) / CATALOG_DAY_SPAN) * 100;
  const dateRangeToPercent =
    ((dateRangeToDay - CATALOG_FIRST_DAY) / CATALOG_DAY_SPAN) * 100;
  const dateRangeHandlesAreTight =
    dateRangeToPercent - dateRangeFromPercent < 8;

  const hierarchicalLayout = useMemo<HierarchicalLayoutAttempt>(() => {
    const width = mapGeometry?.width ?? MAP_WORLD_WIDTH;
    const height = mapGeometry?.height ?? MAP_WORLD_HEIGHT;
    const labelGeometryById = new Map(
      mapGeometry?.labels.map((label) => [label.id, label]) ?? [],
    );
    const paperGeometryById = new Map(
      mapGeometry?.papers.map((paper) => [paper.id, paper]) ?? [],
    );
    const paperAnchors = landscape.papers.map((paper) => ({
      id: paper.id,
      islandId: paper.primaryIsland,
      stabilityRank: paper.layoutRank,
      x: (paper.x / 100) * width,
      y: (paper.y / 100) * height,
      radius:
        ((paperGeometryById.get(paper.id)?.diameter ??
          (paper.role === 'observation'
            ? OBSERVATION_DIAMETER_PX
            : FOLLOW_UP_DIAMETER_PX)) /
          2 +
          NODE_HALO_PX[paper.role]) *
        NODE_ACTIVE_SCALE,
    }));
    const labelAnchors = landscape.islands.map((island) => {
      const geometry = labelGeometryById.get(island.id) ?? {
        width: 120,
        height: 32,
      };
      const anchor = islandLabelAnchor(island);
      return {
        id: island.id,
        islandId: island.id,
        x: (anchor.x / 100) * width,
        y: (anchor.y / 100) * height,
        width: geometry.width,
        height: geometry.height,
      };
    });
    const islandAnchors = landscape.islands.map((island) => {
      const anchor = islandPackingAnchor(island);
      return {
        id: island.id,
        x: (anchor.x / 100) * width,
        y: (anchor.y / 100) * height,
        observation: island.id === 'observation',
      };
    });

    try {
      const packedLayout = createHierarchicalMapLayout(
        width,
        height,
        paperAnchors,
        labelAnchors,
        islandAnchors,
        {
          islandPadding: ISLAND_PADDING_PX,
          observationPadding: OBSERVATION_PACKING_PADDING_PX,
          outerGap: ISLAND_GAP_PX,
        },
      );

      return {
        papers: new Map(
          [...packedLayout.papers].map(([id, point]) => [
            id,
            {
              x: roundMapValue((point.x / width) * 100),
              y: roundMapValue((point.y / height) * 100),
            },
          ]),
        ),
        labels: new Map(
          [...packedLayout.labels].map(([id, point]) => [
            id,
            {
              x: roundMapValue((point.x / width) * 100),
              y: roundMapValue((point.y / height) * 100),
            },
          ]),
        ),
        islands: packedLayout.islands,
        diagnostics: packedLayout.diagnostics,
        errorMessage: null,
      };
    } catch (error) {
      return {
        papers: new Map(
          landscape.papers.map((paper) => [
            paper.id,
            { x: paper.x, y: paper.y },
          ]),
        ),
        labels: new Map(
          landscape.islands.map((island) => [
            island.id,
            islandLabelAnchor(island),
          ]),
        ),
        islands: new Map<string, HierarchicalIslandLayout>(),
        diagnostics: {
          converged: false,
          exactEnclosures: false,
          maxInnerOverlap: Number.MAX_SAFE_INTEGER,
          maxOuterOverlap: Number.MAX_SAFE_INTEGER,
          maxCanvasOverflow: Number.MAX_SAFE_INTEGER,
          maxObservationDrift: 0,
        },
        errorMessage:
          error instanceof Error ? error.message : 'Unknown layout error.',
      };
    }
  }, [mapGeometry]);

  const paperPositions = hierarchicalLayout.papers;
  const labelPositions = hierarchicalLayout.labels;
  const islandCircles = hierarchicalLayout.islands;
  const mapLayoutReady =
    mapFontsReady &&
    mapGeometry !== null &&
    hierarchicalLayout.diagnostics.converged;
  const mapLayoutUnavailable =
    mapFontsReady &&
    mapGeometry !== null &&
    !hierarchicalLayout.diagnostics.converged;

  useEffect(() => {
    if (!mapLayoutUnavailable) return;
    console.error(
      hierarchicalLayout.errorMessage ??
        'The measured map geometry could not be packed without overlap.',
      hierarchicalLayout.diagnostics,
    );
    const frame = requestAnimationFrame(() => {
      const viewport = mapViewportRef.current;
      const gesture = panGestureRef.current;
      if (viewport) {
        viewport.scrollTo({
          left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
          top: Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2),
        });
        if (gesture && viewport.hasPointerCapture(gesture.pointerId)) {
          viewport.releasePointerCapture(gesture.pointerId);
        }
      }
      panGestureRef.current = null;
      setIsPanning(false);
      if (
        document.activeElement &&
        (document.activeElement === viewport ||
          mapCanvasRef.current?.contains(document.activeElement))
      ) {
        mapFallbackButtonRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [hierarchicalLayout, mapLayoutUnavailable]);

  const visibleIds = new Set(visiblePapers.map((paper) => paper.id));
  const visiblePrimaryIslandIds = new Set(
    visiblePapers.map((paper) => paper.primaryIsland),
  );
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
    if (viewMode !== 'map') {
      revealedPaperRef.current = null;
      return;
    }
    if (
      !mapLayoutReady ||
      visiblePapers.length === 0 ||
      revealedPaperRef.current === selectedPaper.id
    ) {
      return;
    }
    revealedPaperRef.current = selectedPaper.id;
    const frame = requestAnimationFrame(() => {
      const viewport = mapViewportRef.current;
      const position = paperPositions.get(selectedPaper.id);
      if (!viewport || !position) return;

      const scaledWidth = MAP_WORLD_WIDTH * zoom;
      const scaledHeight = MAP_WORLD_HEIGHT * zoom;
      const stageWidth = Math.max(viewport.clientWidth, scaledWidth);
      const stageHeight = Math.max(viewport.clientHeight, scaledHeight);
      const paperX =
        (stageWidth - scaledWidth) / 2 + (position.x / 100) * scaledWidth;
      const paperY =
        (stageHeight - scaledHeight) / 2 + (position.y / 100) * scaledHeight;
      const margin = 34;
      let nextLeft = viewport.scrollLeft;
      let nextTop = viewport.scrollTop;

      if (paperX < viewport.scrollLeft + margin) {
        nextLeft = paperX - margin;
      } else if (paperX > viewport.scrollLeft + viewport.clientWidth - margin) {
        nextLeft = paperX - viewport.clientWidth + margin;
      }
      if (paperY < viewport.scrollTop + margin) {
        nextTop = paperY - margin;
      } else if (paperY > viewport.scrollTop + viewport.clientHeight - margin) {
        nextTop = paperY - viewport.clientHeight + margin;
      }
      if (nextLeft !== viewport.scrollLeft || nextTop !== viewport.scrollTop) {
        viewport.scrollTo({
          left: nextLeft,
          top: nextTop,
          behavior: motionSafeScrollBehavior('smooth'),
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    mapLayoutReady,
    paperPositions,
    selectedPaper.id,
    viewMode,
    visiblePapers.length,
    zoom,
  ]);

  useEffect(() => {
    if (viewMode !== 'map' || visiblePapers.length !== 0) return;
    revealedPaperRef.current = null;
    const frame = requestAnimationFrame(() => {
      const viewport = mapViewportRef.current;
      if (!viewport) return;
      viewport.scrollTo({
        left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
        top: Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2),
        behavior: motionSafeScrollBehavior('smooth'),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [viewMode, visiblePapers.length]);

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
    const firstMatch = filterPapers(query, id, dateRange)[0];
    if (firstMatch) selectPaper(firstMatch.id);
  }

  function selectCitationPaper(id: string) {
    focusDetailAfterCitation.current = true;
    setQuery('');
    setActiveIsland('all');
    const paper = paperById.get(id);
    if (paper && !paperInDateRange(paper, dateRange)) {
      resetDateRange();
    }
    selectPaper(id);
  }

  function setPublicationDateRange(nextRange: PaperDateRange) {
    setDateRange(nextRange);
    const nextVisiblePapers = filterPapers(query, activeIsland, nextRange);
    if (
      nextVisiblePapers.length > 0 &&
      !nextVisiblePapers.some((paper) => paper.id === selectedId)
    ) {
      setSelectedId(nextVisiblePapers[0].id);
    }
  }

  function updateDateFromSlider(endpoint: DateEndpoint, dayIndex: number) {
    setDateError(null);
    if (endpoint === 'from') {
      const nextFrom = Math.min(dayIndex, dateRangeToDay);
      const nextRange = {
        from: dayIndexToIsoDate(nextFrom),
        to: dateRange.to,
      };
      setPublicationDateRange(nextRange);
      setFromDateDraft(formatDateField(nextRange.from));
      setToDateDraft(formatDateField(nextRange.to));
      return;
    }
    const nextTo = Math.max(dayIndex, dateRangeFromDay);
    const nextRange = {
      from: dateRange.from,
      to: dayIndexToIsoDate(nextTo),
    };
    setPublicationDateRange(nextRange);
    setFromDateDraft(formatDateField(nextRange.from));
    setToDateDraft(formatDateField(nextRange.to));
  }

  function commitDateDraft(endpoint: DateEndpoint) {
    const parsed = parseDateField(
      endpoint === 'from' ? fromDateDraft : toDateDraft,
    );
    if (!parsed) {
      setDateError(endpoint);
      return;
    }

    const clamped = clampDateToBounds(parsed, CATALOG_DATE_BOUNDS);
    const nextRange =
      endpoint === 'from'
        ? {
            from: clamped,
            to: clamped > dateRange.to ? clamped : dateRange.to,
          }
        : {
            from: clamped < dateRange.from ? clamped : dateRange.from,
            to: clamped,
          };
    setPublicationDateRange(nextRange);
    setFromDateDraft(formatDateField(nextRange.from));
    setToDateDraft(formatDateField(nextRange.to));
    setDateError(null);
  }

  function resetDateRange() {
    setPublicationDateRange(CATALOG_DATE_BOUNDS);
    setFromDateDraft(formatDateField(CATALOG_DATE_BOUNDS.from));
    setToDateDraft(formatDateField(CATALOG_DATE_BOUNDS.to));
    setDateError(null);
  }

  function toggleDateFilter() {
    if (!dateFilterOpen) {
      setFromDateDraft(formatDateField(dateRange.from));
      setToDateDraft(formatDateField(dateRange.to));
      setDateError(null);
      requestAnimationFrame(() => fromDateInputRef.current?.focus());
    }
    setDateFilterOpen((open) => !open);
  }

  function finishPan(pointerId: number) {
    const viewport = mapViewportRef.current;
    if (viewport?.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }
    panGestureRef.current = null;
    setIsPanning(false);
  }

  function positionTooltip(paperId: string, node: HTMLElement) {
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const viewportBounds = viewport.getBoundingClientRect();
    const nodeBounds = node.getBoundingClientRect();
    const leftRoom = nodeBounds.left - viewportBounds.left;
    const rightRoom = viewportBounds.right - nodeBounds.right;
    const topRoom = nodeBounds.top - viewportBounds.top;
    const bottomRoom = viewportBounds.bottom - nodeBounds.bottom;
    const centeredTooltipRoom = 126 * zoom;
    const verticalTooltipRoom = 108 * zoom;
    const nextPlacement: TooltipPlacement = {
      paperId,
      horizontal:
        leftRoom >= centeredTooltipRoom && rightRoom >= centeredTooltipRoom
          ? 'center'
          : rightRoom >= leftRoom
            ? 'right'
            : 'left',
      vertical:
        topRoom >= verticalTooltipRoom || topRoom >= bottomRoom
          ? 'above'
          : 'below',
    };
    if (
      tooltipPlacement?.paperId === nextPlacement.paperId &&
      tooltipPlacement.horizontal === nextPlacement.horizontal &&
      tooltipPlacement.vertical === nextPlacement.vertical
    ) {
      return;
    }
    setTooltipPlacement(nextPlacement);
  }

  function centerMap(behavior: ScrollBehavior = 'smooth') {
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
      top: Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2),
      behavior: motionSafeScrollBehavior(behavior),
    });
  }

  function changeZoom(step: number) {
    const nextZoom = Math.min(1.45, Math.max(0.85, zoom + step));
    if (nextZoom === zoom) return;
    const viewport = mapViewportRef.current;
    const centerX = viewport
      ? (viewport.scrollLeft + viewport.clientWidth / 2) /
        Math.max(viewport.clientWidth, MAP_WORLD_WIDTH * zoom)
      : 0.5;
    const centerY = viewport
      ? (viewport.scrollTop + viewport.clientHeight / 2) /
        Math.max(viewport.clientHeight, MAP_WORLD_HEIGHT * zoom)
      : 0.5;

    setZoom(nextZoom);
    requestAnimationFrame(() => {
      const currentViewport = mapViewportRef.current;
      if (!currentViewport) return;
      const nextWidth = Math.max(
        currentViewport.clientWidth,
        MAP_WORLD_WIDTH * nextZoom,
      );
      const nextHeight = Math.max(
        currentViewport.clientHeight,
        MAP_WORLD_HEIGHT * nextZoom,
      );
      currentViewport.scrollTo({
        left: centerX * nextWidth - currentViewport.clientWidth / 2,
        top: centerY * nextHeight - currentViewport.clientHeight / 2,
      });
    });
  }

  function resetMap() {
    setZoom(1);
    setQuery('');
    setActiveIsland('all');
    resetDateRange();
    requestAnimationFrame(() => requestAnimationFrame(() => centerMap()));
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
          <div className="search-controls" ref={dateFilterRef}>
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
            <Button
              ref={dateFilterButtonRef}
              type="button"
              variant={dateRangeActive ? 'secondary' : 'outline'}
              size="icon"
              className={`date-filter-trigger ${dateRangeActive ? 'is-active' : ''}`}
              aria-label={
                dateRangeActive
                  ? `Publication dates ${formatDateField(dateRange.from)} to ${formatDateField(dateRange.to)}; ${visiblePapers.length} papers shown`
                  : 'Filter papers by publication date'
              }
              aria-haspopup="dialog"
              aria-expanded={dateFilterOpen}
              aria-controls="date-filter-panel"
              onClick={toggleDateFilter}
            >
              <CalendarDays aria-hidden="true" />
            </Button>

            {dateFilterOpen && (
              <dialog
                open
                className="date-filter-popover"
                id="date-filter-panel"
                aria-labelledby="date-filter-title"
              >
                <div className="date-filter-heading">
                  <strong id="date-filter-title">Publication dates</strong>
                  <button
                    type="button"
                    disabled={!dateRangeActive}
                    onClick={resetDateRange}
                  >
                    All dates
                  </button>
                </div>

                <fieldset className="date-filter-fields">
                  <legend className="sr-only">
                    Inclusive publication date interval
                  </legend>
                  <label htmlFor="date-filter-from">
                    <span>From</span>
                    <Input
                      ref={fromDateInputRef}
                      id="date-filter-from"
                      value={fromDateDraft}
                      autoComplete="off"
                      maxLength={10}
                      aria-invalid={dateError === 'from'}
                      aria-describedby={
                        dateError === 'from' ? 'date-filter-error' : undefined
                      }
                      onChange={(event) => {
                        setFromDateDraft(event.target.value);
                        if (dateError === 'from') setDateError(null);
                      }}
                      onBlur={() => commitDateDraft('from')}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        commitDateDraft('from');
                      }}
                    />
                  </label>
                  <label htmlFor="date-filter-to">
                    <span>To</span>
                    <Input
                      id="date-filter-to"
                      value={toDateDraft}
                      autoComplete="off"
                      maxLength={10}
                      aria-invalid={dateError === 'to'}
                      aria-describedby={
                        dateError === 'to' ? 'date-filter-error' : undefined
                      }
                      onChange={(event) => {
                        setToDateDraft(event.target.value);
                        if (dateError === 'to') setDateError(null);
                      }}
                      onBlur={() => commitDateDraft('to')}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        commitDateDraft('to');
                      }}
                    />
                  </label>
                </fieldset>

                <div
                  className={`date-range-slider ${dateRangeHandlesAreTight ? 'has-tight-handles' : ''}`}
                  style={
                    {
                      '--date-range-from': `${dateRangeFromPercent}%`,
                      '--date-range-to': `${dateRangeToPercent}%`,
                    } as React.CSSProperties
                  }
                >
                  <span className="date-range-track" aria-hidden="true" />
                  <span className="date-range-selection" aria-hidden="true" />
                  <span className="date-range-rug" aria-hidden="true">
                    {PUBLICATION_DAY_COUNTS.map(([day, count]) => (
                      <i
                        key={day}
                        style={{
                          left: `${((day - CATALOG_FIRST_DAY) / CATALOG_DAY_SPAN) * 100}%`,
                          height: `${3 + (count / MAX_PUBLICATION_DAY_COUNT) * 6}px`,
                        }}
                      />
                    ))}
                  </span>
                  <label className="sr-only" htmlFor="date-range-from">
                    Start of publication date range
                  </label>
                  <input
                    className="date-range-input date-range-input--from"
                    id="date-range-from"
                    type="range"
                    min={CATALOG_FIRST_DAY}
                    max={CATALOG_LAST_DAY}
                    step={1}
                    value={dateRangeFromDay}
                    aria-valuemax={dateRangeToDay}
                    aria-valuetext={formatDateField(dateRange.from)}
                    onChange={(event) =>
                      updateDateFromSlider('from', Number(event.target.value))
                    }
                  />
                  <label className="sr-only" htmlFor="date-range-to">
                    End of publication date range
                  </label>
                  <input
                    className="date-range-input date-range-input--to"
                    id="date-range-to"
                    type="range"
                    min={CATALOG_FIRST_DAY}
                    max={CATALOG_LAST_DAY}
                    step={1}
                    value={dateRangeToDay}
                    aria-valuemin={dateRangeFromDay}
                    aria-valuetext={formatDateField(dateRange.to)}
                    onChange={(event) =>
                      updateDateFromSlider('to', Number(event.target.value))
                    }
                  />
                </div>

                {dateError && (
                  <p className="date-filter-error" id="date-filter-error">
                    Use DD/MM/YY or DD/MM/YYYY.
                  </p>
                )}

                <output className="date-filter-count" aria-live="polite">
                  <span>
                    {formatDateField(dateRange.from)}–
                    {formatDateField(dateRange.to)}
                  </span>
                  <strong>
                    {visiblePapers.length}{' '}
                    {visiblePapers.length === 1 ? 'paper' : 'papers'}
                  </strong>
                </output>
              </dialog>
            )}
          </div>

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
              Nearby dots share mechanisms, particles, or phenomenology. Each
              sits in one primary island; secondary memberships remain in search
              and filters.
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
              A scheduled review scans arXiv listings, abstracts, paper text,
              and reference trails for work about this specific event. Metadata
              and citation lineage are checked against arXiv; every proposed
              addition is reviewed before publication.
            </p>
            <p>
              Each idea family settles into a compact group, then an exact
              padded circle encloses its dots and label. Those circles repel one
              another while weak attraction keeps the full atlas compact. LZ
              participates in that packing without a visible blob, and the final
              layout remains still. Distance expresses shared ideas, not
              evidence or consensus.
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
                  ref={listViewButtonRef}
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
                    disabled={!mapLayoutReady || zoom <= 0.86}
                    onClick={() => changeZoom(-0.15)}
                  >
                    <Minus />
                  </Button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Zoom in"
                    disabled={!mapLayoutReady || zoom >= 1.44}
                    onClick={() => changeZoom(0.15)}
                  >
                    <Plus />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reset map"
                    disabled={!mapLayoutReady}
                    onClick={resetMap}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {viewMode === 'map' ? (
            <section
              className={`map-viewport ${mapLayoutReady ? 'is-layout-ready' : ''} ${isPanning ? 'is-panning' : ''}`}
              ref={mapViewportRef}
              tabIndex={mapLayoutReady ? 0 : -1}
              aria-label={
                mapLayoutReady
                  ? 'Scrollable paper map. Scroll or drag the background to explore.'
                  : mapLayoutUnavailable
                    ? hierarchicalLayout.errorMessage
                      ? 'Paper map temporarily unavailable.'
                      : 'Paper map unavailable at this size.'
                    : 'Preparing the paper map.'
              }
              aria-describedby={mapLayoutReady ? 'map-pan-help' : undefined}
              aria-busy={!mapFontsReady || mapGeometry === null}
              onPointerDown={(event) => {
                if (!mapLayoutReady) return;
                if (event.button !== 0 || event.pointerType === 'touch') return;
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest('.paper-node')
                ) {
                  return;
                }
                panGestureRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  scrollLeft: event.currentTarget.scrollLeft,
                  scrollTop: event.currentTarget.scrollTop,
                };
                setTooltipPlacement(null);
                event.currentTarget.setPointerCapture(event.pointerId);
                setIsPanning(true);
              }}
              onScroll={() => {
                if (!mapLayoutReady) return;
                if (!tooltipPlacement) return;
                const node = mapCanvasRef.current?.querySelector<HTMLElement>(
                  `[data-paper-node="${tooltipPlacement.paperId}"]`,
                );
                if (node) positionTooltip(tooltipPlacement.paperId, node);
              }}
              onPointerMove={(event) => {
                if (!mapLayoutReady) return;
                const gesture = panGestureRef.current;
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                event.preventDefault();
                event.currentTarget.scrollLeft =
                  gesture.scrollLeft - (event.clientX - gesture.startX);
                event.currentTarget.scrollTop =
                  gesture.scrollTop - (event.clientY - gesture.startY);
              }}
              onPointerUp={(event) => finishPan(event.pointerId)}
              onPointerCancel={(event) => finishPan(event.pointerId)}
            >
              <div
                className="map-stage"
                style={{
                  width: MAP_WORLD_WIDTH * zoom,
                  height: MAP_WORLD_HEIGHT * zoom,
                }}
              >
                <div
                  className={`map-canvas ${mapLayoutReady ? '' : 'is-layout-hidden'}`}
                  ref={mapCanvasRef}
                  aria-hidden={!mapLayoutReady}
                  inert={!mapLayoutReady}
                  style={{
                    width: MAP_WORLD_WIDTH,
                    height: MAP_WORLD_HEIGHT,
                    transform: `translate(-50%, -50%) scale(${zoom})`,
                  }}
                >
                  <svg
                    className="map-contours"
                    viewBox={`0 0 ${mapGeometry?.width ?? MAP_WORLD_WIDTH} ${mapGeometry?.height ?? MAP_WORLD_HEIGHT}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <defs>
                      <pattern
                        id="grid"
                        width="38"
                        height="38"
                        patternUnits="userSpaceOnUse"
                      >
                        <path d="M 38 0 L 0 0 0 38" fill="none" />
                      </pattern>
                      {landscape.islands.flatMap((island) =>
                        island.id === 'observation'
                          ? []
                          : [
                              <radialGradient
                                id={`island-gradient-${island.id}`}
                                key={`island-gradient-${island.id}`}
                                cx="48%"
                                cy="45%"
                                r="72%"
                              >
                                <stop
                                  offset="0%"
                                  stopColor={island.color}
                                  stopOpacity="0.2"
                                />
                                <stop
                                  offset="72%"
                                  stopColor={island.color}
                                  stopOpacity="0.12"
                                />
                                <stop
                                  offset="100%"
                                  stopColor={island.color}
                                  stopOpacity="0"
                                />
                              </radialGradient>,
                            ],
                      )}
                    </defs>
                    <rect width="100%" height="100%" fill="url(#grid)" />
                    {landscape.islands.flatMap((island) => {
                      if (island.id === 'observation') return [];
                      const circle = islandCircles.get(island.id);
                      if (!circle) return [];
                      const hasVisiblePaper = visiblePrimaryIslandIds.has(
                        island.id,
                      );
                      return [
                        <circle
                          className={`island-shape ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                          cx={circle.x}
                          cy={circle.y}
                          r={circle.radius}
                          fill={`url(#island-gradient-${island.id})`}
                          key={`island-${island.id}`}
                        />,
                      ];
                    })}
                  </svg>

                  {landscape.islands.map((island) => {
                    const hasVisiblePaper = visiblePrimaryIslandIds.has(
                      island.id,
                    );
                    const position =
                      labelPositions.get(island.id) ??
                      islandLabelAnchor(island);
                    return (
                      <div
                        className={`island-label ${mapLayoutReady ? '' : 'is-measuring'} ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                        data-island-label={island.id}
                        aria-hidden={!mapLayoutReady || !hasVisiblePaper}
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

                  {landscape.papers.map((paper) => {
                    const island = islandById.get(
                      paper.primaryIsland,
                    ) as Island;
                    const isVisible = visibleIds.has(paper.id);
                    const isSelected = selectedPaper.id === paper.id;
                    const position = paperPositions.get(paper.id) ?? paper;
                    const activeTooltipPlacement =
                      tooltipPlacement?.paperId === paper.id
                        ? tooltipPlacement
                        : null;
                    const tooltipEdgeClass =
                      activeTooltipPlacement?.horizontal === 'right'
                        ? 'paper-node--tooltip-right'
                        : activeTooltipPlacement?.horizontal === 'left'
                          ? 'paper-node--tooltip-left'
                          : '';
                    const tooltipVerticalClass =
                      activeTooltipPlacement?.vertical === 'below'
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
                        onPointerEnter={(event) =>
                          positionTooltip(paper.id, event.currentTarget)
                        }
                        onFocus={(event) =>
                          positionTooltip(paper.id, event.currentTarget)
                        }
                        data-paper-node={paper.id}
                        aria-label={`Open ${paper.title}`}
                        aria-describedby={
                          authorLabel ? tooltipAuthorId : undefined
                        }
                        aria-pressed={isSelected}
                        tabIndex={mapLayoutReady ? 0 : -1}
                      >
                        {paper.role === 'observation' && (
                          <span className="paper-node-monogram">LZ</span>
                        )}
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
                      <span>
                        {dateRangeActive
                          ? 'Try widening the dates or changing another filter.'
                          : 'Try a mechanism, author, or arXiv ID.'}
                      </span>
                    </div>
                  )}
                </div>
                {mapLayoutUnavailable && (
                  <output className="map-layout-unavailable">
                    <strong>
                      {hierarchicalLayout.errorMessage
                        ? 'Map layout is temporarily unavailable.'
                        : 'The map needs more room at this size.'}
                    </strong>
                    <span>
                      Matching papers remain available in the list view.
                    </span>
                    <Button
                      ref={mapFallbackButtonRef}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setViewMode('list');
                        requestAnimationFrame(() =>
                          listViewButtonRef.current?.focus(),
                        );
                      }}
                    >
                      <List aria-hidden="true" /> Open list view
                    </Button>
                  </output>
                )}
              </div>
            </section>
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
                  <span>
                    {dateRangeActive
                      ? 'Try widening the dates or changing another filter.'
                      : 'Try a mechanism, author, or arXiv ID.'}
                  </span>
                </div>
              )}
            </div>
          )}

          <footer className="map-footer">
            <span>Distance expresses shared ideas—not evidence strength.</span>
            <span id="map-pan-help">
              {viewMode === 'map'
                ? mapLayoutReady
                  ? 'Scroll or drag to explore · citation lineage is in the paper details.'
                  : mapLayoutUnavailable
                    ? 'Use the list view to browse matching papers.'
                    : 'Preparing the map…'
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

          <a
            className="paper-link"
            href={selectedPaper.url}
            target="_blank"
            rel="noreferrer"
          >
            Read on arXiv
            <ExternalLink aria-hidden="true" />
          </a>

          <section
            className="citation-lineage"
            aria-labelledby="citation-lineage-title"
          >
            <h3 id="citation-lineage-title">Citation lineage</h3>
            <CitationGroup
              title="Cites on this map"
              papers={selectedCites}
              relationship="cites"
              dateRange={dateRange}
              dateRangeActive={dateRangeActive}
              onSelect={selectCitationPaper}
            />
            <CitationGroup
              title="Cited by on this map"
              papers={selectedCitedBy}
              relationship="cited-by"
              dateRange={dateRange}
              dateRangeActive={dateRangeActive}
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

          <p className="screening-note">
            Metadata comes from arXiv. Summaries and placement are
            machine-assisted; inclusion is not endorsement or peer review.
          </p>
        </aside>
      </section>
    </main>
  );
}
