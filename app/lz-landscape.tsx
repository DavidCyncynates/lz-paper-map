'use client';

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- The scrollable map is an intentionally keyboard- and pointer-operable viewport. */

import {
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowUpRight,
  BookOpenText,
  CalendarDays,
  ExternalLink,
  List,
  Map as MapIcon,
  Maximize2,
  Minus,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/theme-toggle';
import generatedMapLayouts from '@/data/generated/map-layouts.json';
import landscape from '@/data/landscape.json';
import {
  type HierarchicalIslandLayout,
  type HierarchicalLayoutDiagnostics,
} from '@/lib/hierarchical-map-layout';
import {
  dampMapWheelScale,
  DEFAULT_MAP_MAX_SCALE,
  DEFAULT_MAP_MIN_SCALE,
  fitMapCamera,
  mapWheelTargetScale,
  type MapCameraState,
  transformMapBetweenAnchors,
  zoomMapAtAnchor,
} from '@/lib/map-camera';
import {
  canonicalIslandLabelSize,
  ISLAND_LABEL_KICKER_FONT_SIZE_PX,
  ISLAND_LABEL_KICKER_LINE_HEIGHT_PX,
  ISLAND_LABEL_TITLE_FONT_SIZE_PX,
  ISLAND_LABEL_TITLE_LINE_HEIGHT_PX,
  islandLabelAnchor,
  mapPaperDiameter,
  type MapLayoutMode,
} from '@/lib/map-layout-config';
import { incomingCitationCounts } from '@/lib/paper-citation-size';
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
type NodeSizeMode = MapLayoutMode;
type DateEndpoint = 'from' | 'to';
type MapPoint = { x: number; y: number };
type HierarchicalLayoutAttempt = {
  width: number;
  height: number;
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
  active: boolean;
};
type PinchGesture = {
  pointerIds: [number, number];
  startDistance: number;
  startMidpoint: MapPoint;
  startCamera: MapCameraState;
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
const MAPPED_CITATION_COUNTS = incomingCitationCounts(landscape.papers);
const NORMALIZED_SEARCH_TEXT_BY_ID = new Map(
  landscape.papers.map((paper) => [
    paper.id,
    normalizeSearchText(
      [
        paper.title,
        paper.summary,
        paper.takeaway,
        paper.arxivId,
        ...paper.authors,
        ...paper.tags,
      ].join(' '),
    ),
  ]),
);
const CITED_BY_IDS_BY_ID = new Map<string, string[]>(
  landscape.papers.map((paper) => [paper.id, []]),
);
for (const paper of landscape.papers) {
  for (const citedId of paper.cites) {
    CITED_BY_IDS_BY_ID.get(citedId)?.push(paper.id);
  }
}
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

function midpoint(first: MapPoint, second: MapPoint): MapPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function pointDistance(first: MapPoint, second: MapPoint) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function paperNodeDiameter(paper: Paper, mode: NodeSizeMode) {
  const diameter = mapPaperDiameter(
    paper,
    mode,
    MAPPED_CITATION_COUNTS.get(paper.id) ?? 0,
  );
  // Keep SSR and browser style strings identical across JavaScript runtimes.
  return Math.round(diameter * 1000) / 1000;
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

function isUnmodifiedPrimaryClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

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

function normalizeSearchText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function filterPapers(
  query: string,
  islandId: string,
  dateRange: PaperDateRange = CATALOG_DATE_BOUNDS,
) {
  const normalized = normalizeSearchText(query);
  return landscape.papers.filter((paper) => {
    const inIsland = islandId === 'all' || paper.primaryIsland === islandId;
    return (
      inIsland &&
      paperInDateRange(paper, dateRange) &&
      (!normalized ||
        NORMALIZED_SEARCH_TEXT_BY_ID.get(paper.id)?.includes(normalized))
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
            <a
              href={`papers/${encodeURIComponent(paper.id)}/`}
              onClick={(event) => {
                if (!isUnmodifiedPrimaryClick(event)) return;
                event.preventDefault();
                onSelect(paper.id);
              }}
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
            </a>
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
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [nodeSizeMode, setNodeSizeMode] = useState<NodeSizeMode>('citations');
  const [isPanning, setIsPanning] = useState(false);
  const [tooltipPlacement, setTooltipPlacement] =
    useState<TooltipPlacement | null>(null);
  const mapViewportRef = useRef<HTMLElement>(null);
  const mapStageRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const zoomOutputRef = useRef<HTMLOutputElement>(null);
  const zoomOutButtonRef = useRef<HTMLButtonElement>(null);
  const zoomInButtonRef = useRef<HTMLButtonElement>(null);
  const mapFallbackButtonRef = useRef<HTMLButtonElement>(null);
  const listViewButtonRef = useRef<HTMLButtonElement>(null);
  const dateFilterRef = useRef<HTMLDivElement>(null);
  const dateFilterButtonRef = useRef<HTMLButtonElement>(null);
  const fromDateInputRef = useRef<HTMLInputElement>(null);
  const dateRangeRef = useRef(dateRange);
  const panGestureRef = useRef<PanGesture | null>(null);
  const touchPointersRef = useRef(new Map<number, MapPoint>());
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const suppressMapActivationRef = useRef(false);
  const activationSuppressionTimerRef = useRef<number | null>(null);
  const cameraRef = useRef<MapCameraState>({
    scale: 1,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const cameraFrameRef = useRef<number | null>(null);
  const cameraApplyingRef = useRef(false);
  const cameraScrollBehaviorRef = useRef<ScrollBehavior>('auto');
  const wheelTargetScaleRef = useRef<number | null>(null);
  const wheelAnchorRef = useRef<MapPoint | null>(null);
  const wheelFrameTimeRef = useRef<number | null>(null);
  const pinchUpdatePendingRef = useRef(false);
  const cameraInitializedRef = useRef(false);
  const cameraIsFitRef = useRef(true);
  const revealedPaperRef = useRef<string | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const focusDetailAfterCitation = useRef(false);
  dateRangeRef.current = dateRange;

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
    const storedLayout = generatedMapLayouts.modes[nodeSizeMode];
    return {
      width: storedLayout.width,
      height: storedLayout.height,
      papers: new Map(Object.entries(storedLayout.papers)),
      labels: new Map(Object.entries(storedLayout.labels)),
      islands: new Map(Object.entries(storedLayout.islands)) as Map<
        string,
        HierarchicalIslandLayout
      >,
      diagnostics: storedLayout.diagnostics as HierarchicalLayoutDiagnostics,
      errorMessage: storedLayout.diagnostics.converged
        ? null
        : 'The generated map layout did not converge.',
    };
  }, [nodeSizeMode]);

  const paperPositions = hierarchicalLayout.papers;
  const labelPositions = hierarchicalLayout.labels;
  const islandCircles = hierarchicalLayout.islands;
  const mapWorldWidth = hierarchicalLayout.width;
  const mapWorldHeight = hierarchicalLayout.height;
  const mapLayoutReady = hierarchicalLayout.diagnostics.converged;
  const mapLayoutUnavailable = !mapLayoutReady;

  useLayoutEffect(() => {
    if (viewMode !== 'map' || !mapLayoutReady) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const restoreOrFit = () => {
      if (!cameraInitializedRef.current || cameraIsFitRef.current) {
        fitMapToViewport('auto', true);
      } else {
        commitMapCamera(cameraRef.current, 'auto', true);
      }
    };
    const refitIfNeeded = () => {
      if (cameraIsFitRef.current) fitMapToViewport('auto');
    };
    restoreOrFit();
    const observer = new ResizeObserver(refitIfNeeded);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
    // The camera function closes over the same world dimensions listed here;
    // its mutable camera state lives in refs and must not restart observation.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLayoutReady, mapWorldHeight, mapWorldWidth, viewMode]);

  useEffect(() => {
    if (viewMode !== 'map' || !mapLayoutReady) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const zoomWithWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const bounds = viewport.getBoundingClientRect();
      const deltaPixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * viewport.clientHeight
            : event.deltaY;
      const currentCamera = readMapCamera(viewport);
      cameraRef.current = currentCamera;
      const targetScale = mapWheelTargetScale(
        wheelTargetScaleRef.current ?? currentCamera.scale,
        deltaPixels,
      );
      const targetWillMoveCamera =
        Math.abs(targetScale - currentCamera.scale) >= 1e-6;
      if (!targetWillMoveCamera && wheelTargetScaleRef.current === null) {
        return;
      }
      event.preventDefault();
      wheelTargetScaleRef.current = targetScale;
      wheelAnchorRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      cameraInitializedRef.current = true;
      cameraIsFitRef.current = false;
      scheduleMapCameraFrame();
    };
    viewport.addEventListener('wheel', zoomWithWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', zoomWithWheel);
    // The native listener needs current geometry, while camera state itself is
    // ref-backed so wheel events can compose within a single animation frame.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLayoutReady, mapWorldHeight, mapWorldWidth, viewMode]);

  useEffect(
    () => () => {
      if (cameraFrameRef.current !== null) {
        cancelAnimationFrame(cameraFrameRef.current);
      }
      cancelWheelZoom();
      pinchUpdatePendingRef.current = false;
      if (activationSuppressionTimerRef.current !== null) {
        window.clearTimeout(activationSuppressionTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (viewMode === 'map' && mapLayoutReady) return;
    touchPointersRef.current.clear();
    pinchGestureRef.current = null;
    pinchUpdatePendingRef.current = false;
    panGestureRef.current = null;
    cancelWheelZoom();
    resetMapActivationSuppression();
    let isCurrent = true;
    queueMicrotask(() => {
      if (isCurrent) setIsPanning(false);
    });
    return () => {
      isCurrent = false;
    };
  }, [mapLayoutReady, viewMode]);

  useEffect(() => {
    if (!mapLayoutUnavailable) return;
    console.error(
      hierarchicalLayout.errorMessage ??
        'The generated map geometry could not be packed without overlap.',
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
  const selectedCitedBy = (
    CITED_BY_IDS_BY_ID.get(selectedPaper.id) ?? []
  ).flatMap((paperId: string) => {
    const paper = paperById.get(paperId);
    return paper ? [paper] : [];
  });

  useEffect(() => {
    if (viewMode !== 'map') return;
    const revealKey = `${nodeSizeMode}:${selectedPaper.id}`;
    if (
      !mapLayoutReady ||
      visiblePapers.length === 0 ||
      revealedPaperRef.current === revealKey
    ) {
      return;
    }
    revealedPaperRef.current = revealKey;
    const frame = requestAnimationFrame(() => {
      const viewport = mapViewportRef.current;
      const position = paperPositions.get(selectedPaper.id);
      if (!viewport || !position) return;

      const cameraScale = cameraRef.current.scale;
      const scaledWidth = mapWorldWidth * cameraScale;
      const scaledHeight = mapWorldHeight * cameraScale;
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
    nodeSizeMode,
    paperPositions,
    selectedPaper.id,
    viewMode,
    visiblePapers.length,
    mapWorldHeight,
    mapWorldWidth,
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

  function readMapCamera(viewport: HTMLElement): MapCameraState {
    return cameraFrameRef.current !== null || cameraApplyingRef.current
      ? cameraRef.current
      : {
          scale: cameraRef.current.scale,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop,
        };
  }

  function resetMapActivationSuppression() {
    suppressMapActivationRef.current = false;
    if (activationSuppressionTimerRef.current !== null) {
      window.clearTimeout(activationSuppressionTimerRef.current);
      activationSuppressionTimerRef.current = null;
    }
  }

  function brieflySuppressMapActivation() {
    suppressMapActivationRef.current = true;
    if (activationSuppressionTimerRef.current !== null) {
      window.clearTimeout(activationSuppressionTimerRef.current);
    }
    activationSuppressionTimerRef.current = window.setTimeout(() => {
      suppressMapActivationRef.current = false;
      activationSuppressionTimerRef.current = null;
    }, 450);
  }

  function pointerViewportPoint(
    viewport: HTMLElement,
    clientX: number,
    clientY: number,
  ): MapPoint {
    const bounds = viewport.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }

  function beginPinchGesture(viewport: HTMLElement) {
    cancelWheelZoom();
    pinchUpdatePendingRef.current = false;
    const touches = [...touchPointersRef.current.entries()].slice(0, 2);
    if (touches.length < 2) {
      pinchGestureRef.current = null;
      return;
    }
    const [[firstId, first], [secondId, second]] = touches;
    const startCamera = readMapCamera(viewport);
    cameraRef.current = startCamera;
    pinchGestureRef.current = {
      pointerIds: [firstId, secondId],
      startDistance: Math.max(1, pointDistance(first, second)),
      startMidpoint: midpoint(first, second),
      startCamera,
    };
    panGestureRef.current = null;
    cameraInitializedRef.current = true;
    cameraIsFitRef.current = false;
    brieflySuppressMapActivation();
    for (const pointerId of [firstId, secondId]) {
      if (!viewport.hasPointerCapture(pointerId)) {
        viewport.setPointerCapture(pointerId);
      }
    }
    setIsPanning(true);
  }

  function finishMapPointer(pointerId: number, isTouch: boolean) {
    const viewport = mapViewportRef.current;
    if (!isTouch) {
      if (viewport?.hasPointerCapture(pointerId)) {
        viewport.releasePointerCapture(pointerId);
      }
      panGestureRef.current = null;
      setIsPanning(false);
      return;
    }

    if (viewport && pinchUpdatePendingRef.current) {
      resolvePendingPinchCamera(viewport);
      scheduleMapCameraFrame();
    }

    const endingPan = panGestureRef.current;
    const endedActiveGesture =
      pinchGestureRef.current !== null ||
      (endingPan?.pointerId === pointerId && endingPan.active);
    touchPointersRef.current.delete(pointerId);
    if (viewport?.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }
    if (endedActiveGesture) brieflySuppressMapActivation();
    pinchGestureRef.current = null;
    if (viewport && touchPointersRef.current.size >= 2) {
      beginPinchGesture(viewport);
      return;
    }
    const remainingTouch = touchPointersRef.current.entries().next().value as
      | [number, MapPoint]
      | undefined;
    if (viewport && remainingTouch) {
      const [remainingId, point] = remainingTouch;
      const currentCamera = readMapCamera(viewport);
      cameraRef.current = currentCamera;
      panGestureRef.current = {
        pointerId: remainingId,
        startX: point.x,
        startY: point.y,
        scrollLeft: currentCamera.scrollLeft,
        scrollTop: currentCamera.scrollTop,
        active: true,
      };
      setIsPanning(true);
      return;
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
    const cameraScale = cameraRef.current.scale;
    const centeredTooltipRoom = 126 * cameraScale;
    const verticalTooltipRoom = 108 * cameraScale;
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

  function cancelWheelZoom() {
    wheelTargetScaleRef.current = null;
    wheelAnchorRef.current = null;
    wheelFrameTimeRef.current = null;
  }

  function resolvePendingPinchCamera(viewport: HTMLElement) {
    if (!pinchUpdatePendingRef.current) return;
    pinchUpdatePendingRef.current = false;
    const pinch = pinchGestureRef.current;
    if (!pinch) return;
    const first = touchPointersRef.current.get(pinch.pointerIds[0]);
    const second = touchPointersRef.current.get(pinch.pointerIds[1]);
    if (!first || !second) return;
    const nextMidpoint = midpoint(first, second);
    const nextDistance = Math.max(1, pointDistance(first, second));
    cameraRef.current = transformMapBetweenAnchors({
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      },
      world: { width: mapWorldWidth, height: mapWorldHeight },
      current: pinch.startCamera,
      nextScale: pinch.startCamera.scale * (nextDistance / pinch.startDistance),
      currentAnchor: pinch.startMidpoint,
      nextAnchor: nextMidpoint,
    });
    cameraScrollBehaviorRef.current = 'auto';
    cameraInitializedRef.current = true;
    cameraIsFitRef.current = false;
  }

  function applyMapCamera(
    viewport: HTMLElement,
    target: MapCameraState,
    behavior: ScrollBehavior,
  ) {
    cameraApplyingRef.current = true;
    try {
      const stage = mapStageRef.current;
      if (stage) {
        stage.style.width = `${mapWorldWidth * target.scale}px`;
        stage.style.height = `${mapWorldHeight * target.scale}px`;
      }
      const canvas = mapCanvasRef.current;
      if (canvas) {
        canvas.style.transform = `translate(-50%, -50%) scale(${target.scale})`;
      }
      if (zoomOutputRef.current) {
        zoomOutputRef.current.value = `${Math.round(target.scale * 100)}%`;
      }
      if (zoomOutButtonRef.current) {
        zoomOutButtonRef.current.disabled =
          !mapLayoutReady || target.scale <= DEFAULT_MAP_MIN_SCALE + 1e-3;
      }
      if (zoomInButtonRef.current) {
        zoomInButtonRef.current.disabled =
          !mapLayoutReady || target.scale >= DEFAULT_MAP_MAX_SCALE - 1e-3;
      }
      viewport.scrollTo({
        left: target.scrollLeft,
        top: target.scrollTop,
        behavior: motionSafeScrollBehavior(behavior),
      });
    } finally {
      cameraApplyingRef.current = false;
    }
  }

  function flushMapCameraFrame(timestamp: number) {
    const viewport = mapViewportRef.current;
    if (!viewport) {
      cameraFrameRef.current = null;
      return;
    }

    resolvePendingPinchCamera(viewport);
    let continueWheelAnimation = false;
    const wheelTargetScale = wheelTargetScaleRef.current;
    const wheelAnchor = wheelAnchorRef.current;
    if (wheelTargetScale !== null && wheelAnchor) {
      const previousTime = wheelFrameTimeRef.current;
      const elapsedMs =
        previousTime === null
          ? 1000 / 60
          : Math.max(0, timestamp - previousTime);
      const currentCamera = cameraRef.current;
      const dampedScale = dampMapWheelScale(
        currentCamera.scale,
        wheelTargetScale,
        elapsedMs,
        {
          reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)')
            .matches,
        },
      );
      const reachedTarget =
        Math.abs(Math.log(dampedScale / wheelTargetScale)) < 0.001;
      cameraRef.current = zoomMapAtAnchor({
        viewport: {
          width: viewport.clientWidth,
          height: viewport.clientHeight,
        },
        world: { width: mapWorldWidth, height: mapWorldHeight },
        current: currentCamera,
        nextScale: reachedTarget ? wheelTargetScale : dampedScale,
        anchor: wheelAnchor,
      });
      cameraScrollBehaviorRef.current = 'auto';
      wheelFrameTimeRef.current = timestamp;
      if (reachedTarget) {
        cancelWheelZoom();
      } else {
        continueWheelAnimation = true;
      }
    }

    applyMapCamera(
      viewport,
      cameraRef.current,
      cameraScrollBehaviorRef.current,
    );
    cameraFrameRef.current = null;
    if (continueWheelAnimation || pinchUpdatePendingRef.current) {
      scheduleMapCameraFrame();
    }
  }

  function scheduleMapCameraFrame() {
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = requestAnimationFrame(flushMapCameraFrame);
  }

  function commitMapCamera(
    nextCamera: MapCameraState,
    behavior: ScrollBehavior = 'auto',
    immediate = false,
  ) {
    cancelWheelZoom();
    cameraRef.current = nextCamera;
    cameraScrollBehaviorRef.current = behavior;
    if (!immediate) {
      scheduleMapCameraFrame();
      return;
    }
    if (cameraFrameRef.current !== null) {
      cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }
    const viewport = mapViewportRef.current;
    if (viewport) applyMapCamera(viewport, nextCamera, behavior);
  }

  function fitMapToViewport(
    behavior: ScrollBehavior = 'smooth',
    immediate = false,
  ) {
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    cameraInitializedRef.current = true;
    cameraIsFitRef.current = true;
    commitMapCamera(
      fitMapCamera(
        { width: viewport.clientWidth, height: viewport.clientHeight },
        { width: mapWorldWidth, height: mapWorldHeight },
      ),
      behavior,
      immediate,
    );
  }

  function zoomAtViewportPoint(
    nextScale: number,
    anchor: MapPoint,
    behavior: ScrollBehavior = 'auto',
  ) {
    const viewport = mapViewportRef.current;
    if (!viewport || !mapLayoutReady) return;
    const pendingCamera = cameraFrameRef.current !== null;
    const currentCamera = pendingCamera
      ? cameraRef.current
      : {
          scale: cameraRef.current.scale,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop,
        };
    const nextCamera = zoomMapAtAnchor({
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      },
      world: { width: mapWorldWidth, height: mapWorldHeight },
      current: currentCamera,
      nextScale,
      anchor,
    });
    if (Math.abs(nextCamera.scale - currentCamera.scale) < 1e-6) return;
    cameraInitializedRef.current = true;
    cameraIsFitRef.current = false;
    commitMapCamera(nextCamera, behavior);
  }

  function changeZoom(direction: -1 | 1) {
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const factor = direction > 0 ? 1.2 : 1 / 1.2;
    zoomAtViewportPoint(cameraRef.current.scale * factor, {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    });
  }

  function handleMapKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      viewMode !== 'map' ||
      !mapLayoutReady ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      changeZoom(1);
    } else if (event.key === '-') {
      event.preventDefault();
      changeZoom(-1);
    } else if (event.key === '0' || event.key.toLocaleLowerCase('en') === 'f') {
      event.preventDefault();
      fitMapToViewport();
    } else if (
      event.target === mapViewportRef.current &&
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'PageUp',
        'PageDown',
      ].includes(event.key)
    ) {
      cameraIsFitRef.current = false;
    }
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
          <div>
            <h1>LZ Paper Map</h1>
            <small>248 keV papers &amp; summaries</small>
          </div>
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
          <ThemeToggle />
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
              const count = landscape.papers.filter(
                (paper) => paper.primaryIsland === island.id,
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
              This map collects papers responding to LUX-ZEPLIN&apos;s isolated
              248 keV high-recoil candidate. Nearby dots share mechanisms,
              particles, or phenomenology; select one for a concise summary and
              citation lineage.
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
              The source result is one isolated 248 keV candidate (LZ230616),
              also discussed as the LZ high-recoil event or LZ excess; it is not
              a discovery.
            </p>
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

        <section
          className="map-panel"
          aria-label="Paper landscape"
          onKeyDown={handleMapKeyDown}
        >
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
                <>
                  <Button
                    className="citation-size-toggle"
                    variant={
                      nodeSizeMode === 'citations' ? 'secondary' : 'outline'
                    }
                    size="sm"
                    aria-label="Size dots by citations on this map"
                    aria-pressed={nodeSizeMode === 'citations'}
                    title="Size dots by incoming citations from papers on this map"
                    onClick={() => {
                      setNodeSizeMode((current) =>
                        current === 'uniform' ? 'citations' : 'uniform',
                      );
                      setTooltipPlacement(null);
                      revealedPaperRef.current = null;
                    }}
                  >
                    <BookOpenText aria-hidden="true" />
                    <span>Citations</span>
                  </Button>
                  <div className="zoom-controls" aria-label="Map zoom controls">
                    <Button
                      ref={zoomOutButtonRef}
                      variant="outline"
                      size="icon-sm"
                      aria-label="Zoom out"
                      aria-keyshortcuts="-"
                      disabled={!mapLayoutReady}
                      onClick={() => changeZoom(-1)}
                    >
                      <Minus />
                    </Button>
                    <output ref={zoomOutputRef} aria-label="Map zoom level">
                      100%
                    </output>
                    <Button
                      ref={zoomInButtonRef}
                      variant="outline"
                      size="icon-sm"
                      aria-label="Zoom in"
                      aria-keyshortcuts="+"
                      disabled={!mapLayoutReady}
                      onClick={() => changeZoom(1)}
                    >
                      <Plus />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Fit the full map in view"
                      aria-keyshortcuts="0 f"
                      title="Fit map (0 or F)"
                      disabled={!mapLayoutReady}
                      onClick={() => fitMapToViewport()}
                    >
                      <Maximize2 />
                    </Button>
                  </div>
                </>
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
                  ? 'Interactive paper map. Drag to move and scroll or pinch to zoom.'
                  : mapLayoutUnavailable
                    ? hierarchicalLayout.errorMessage
                      ? 'Paper map temporarily unavailable.'
                      : 'Paper map unavailable at this size.'
                    : 'Preparing the paper map.'
              }
              aria-describedby={mapLayoutReady ? 'map-pan-help' : undefined}
              aria-busy={!mapLayoutReady}
              aria-keyshortcuts="+ - 0 f"
              onDoubleClick={(event) => {
                if (!mapLayoutReady) return;
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest('.paper-node, .island-label')
                ) {
                  return;
                }
                const bounds = event.currentTarget.getBoundingClientRect();
                zoomAtViewportPoint(
                  cameraRef.current.scale * (event.shiftKey ? 1 / 1.35 : 1.35),
                  {
                    x: event.clientX - bounds.left,
                    y: event.clientY - bounds.top,
                  },
                );
              }}
              onPointerDown={(event) => {
                if (!mapLayoutReady) return;
                if (event.button !== 0) return;
                if (event.pointerType === 'touch') {
                  cancelWheelZoom();
                  if (touchPointersRef.current.size === 0) {
                    resetMapActivationSuppression();
                  }
                  const point = pointerViewportPoint(
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                  touchPointersRef.current.set(event.pointerId, point);
                  setTooltipPlacement(null);
                  if (touchPointersRef.current.size >= 2) {
                    beginPinchGesture(event.currentTarget);
                  } else {
                    const currentCamera = readMapCamera(event.currentTarget);
                    cameraRef.current = currentCamera;
                    panGestureRef.current = {
                      pointerId: event.pointerId,
                      startX: point.x,
                      startY: point.y,
                      scrollLeft: currentCamera.scrollLeft,
                      scrollTop: currentCamera.scrollTop,
                      active: false,
                    };
                    setIsPanning(true);
                  }
                  return;
                }
                cancelWheelZoom();
                resetMapActivationSuppression();
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest('.paper-node, .island-label')
                ) {
                  return;
                }
                cameraIsFitRef.current = false;
                panGestureRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  scrollLeft: event.currentTarget.scrollLeft,
                  scrollTop: event.currentTarget.scrollTop,
                  active: true,
                };
                setTooltipPlacement(null);
                event.currentTarget.setPointerCapture(event.pointerId);
                setIsPanning(true);
              }}
              onScroll={() => {
                if (!mapLayoutReady) return;
                const viewport = mapViewportRef.current;
                if (
                  viewport &&
                  cameraFrameRef.current === null &&
                  !cameraApplyingRef.current
                ) {
                  cameraRef.current = {
                    scale: cameraRef.current.scale,
                    scrollLeft: viewport.scrollLeft,
                    scrollTop: viewport.scrollTop,
                  };
                }
                if (!tooltipPlacement) return;
                const node = mapCanvasRef.current?.querySelector<HTMLElement>(
                  `[data-paper-node="${tooltipPlacement.paperId}"]`,
                );
                if (node) positionTooltip(tooltipPlacement.paperId, node);
              }}
              onPointerMove={(event) => {
                if (!mapLayoutReady) return;
                if (event.pointerType === 'touch') {
                  if (!touchPointersRef.current.has(event.pointerId)) return;
                  const point = pointerViewportPoint(
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                  touchPointersRef.current.set(event.pointerId, point);
                  const pinch = pinchGestureRef.current;
                  if (pinch) {
                    const first = touchPointersRef.current.get(
                      pinch.pointerIds[0],
                    );
                    const second = touchPointersRef.current.get(
                      pinch.pointerIds[1],
                    );
                    if (!first || !second) {
                      beginPinchGesture(event.currentTarget);
                      return;
                    }
                    event.preventDefault();
                    brieflySuppressMapActivation();
                    pinchUpdatePendingRef.current = true;
                    scheduleMapCameraFrame();
                    return;
                  }
                }
                const gesture = panGestureRef.current;
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                const currentPoint =
                  event.pointerType === 'touch'
                    ? (touchPointersRef.current.get(event.pointerId) ?? {
                        x: event.clientX,
                        y: event.clientY,
                      })
                    : { x: event.clientX, y: event.clientY };
                const deltaX = currentPoint.x - gesture.startX;
                const deltaY = currentPoint.y - gesture.startY;
                if (event.pointerType === 'touch' && !gesture.active) {
                  if (Math.hypot(deltaX, deltaY) <= 5) return;
                  gesture.active = true;
                  cameraInitializedRef.current = true;
                  cameraIsFitRef.current = false;
                  brieflySuppressMapActivation();
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }
                }
                if (event.pointerType === 'touch') {
                  brieflySuppressMapActivation();
                }
                event.preventDefault();
                event.currentTarget.scrollLeft = gesture.scrollLeft - deltaX;
                event.currentTarget.scrollTop = gesture.scrollTop - deltaY;
                cameraRef.current = {
                  scale: cameraRef.current.scale,
                  scrollLeft: event.currentTarget.scrollLeft,
                  scrollTop: event.currentTarget.scrollTop,
                };
              }}
              onPointerUp={(event) =>
                finishMapPointer(event.pointerId, event.pointerType === 'touch')
              }
              onPointerCancel={(event) =>
                finishMapPointer(event.pointerId, event.pointerType === 'touch')
              }
              onLostPointerCapture={(event) => {
                const trackedTouch =
                  event.pointerType === 'touch' &&
                  touchPointersRef.current.has(event.pointerId);
                const trackedPan =
                  event.pointerType !== 'touch' &&
                  panGestureRef.current?.pointerId === event.pointerId;
                if (trackedTouch || trackedPan) {
                  finishMapPointer(event.pointerId, trackedTouch);
                }
              }}
            >
              <div
                className="map-stage"
                ref={mapStageRef}
                style={{
                  width: mapWorldWidth,
                  height: mapWorldHeight,
                }}
              >
                <div
                  className={`map-canvas ${mapLayoutReady ? '' : 'is-layout-hidden'}`}
                  ref={mapCanvasRef}
                  aria-hidden={!mapLayoutReady}
                  inert={!mapLayoutReady}
                  style={{
                    width: mapWorldWidth,
                    height: mapWorldHeight,
                    transform: 'translate(-50%, -50%) scale(1)',
                  }}
                >
                  <svg
                    className="map-contours"
                    viewBox={`0 0 ${mapWorldWidth} ${mapWorldHeight}`}
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
                                  className="island-gradient-stop island-gradient-stop--core"
                                  offset="0%"
                                  stopColor={island.color}
                                  stopOpacity="0.2"
                                />
                                <stop
                                  className="island-gradient-stop island-gradient-stop--middle"
                                  offset="72%"
                                  stopColor={island.color}
                                  stopOpacity="0.12"
                                />
                                <stop
                                  className="island-gradient-stop island-gradient-stop--edge"
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
                    const labelSize = canonicalIslandLabelSize(island);
                    const position =
                      labelPositions.get(island.id) ??
                      islandLabelAnchor(island);
                    const summaryEdgeClass =
                      position.x < 25
                        ? 'island-label--summary-right'
                        : position.x > 75
                          ? 'island-label--summary-left'
                          : '';
                    const summaryVerticalClass =
                      position.y < 25 ? 'island-label--summary-below' : '';
                    const summaryId = `island-summary-${island.id}`;
                    return (
                      <button
                        type="button"
                        className={`island-label ${summaryEdgeClass} ${summaryVerticalClass} ${mapLayoutReady ? '' : 'is-measuring'} ${hasVisiblePaper ? '' : 'is-dimmed'}`}
                        data-island-label={island.id}
                        aria-label={`${island.label}: ${island.kicker}`}
                        aria-hidden={!mapLayoutReady || !hasVisiblePaper}
                        aria-describedby={summaryId}
                        key={`label-${island.id}`}
                        tabIndex={mapLayoutReady && hasVisiblePaper ? 0 : -1}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.currentTarget.blur();
                          }
                        }}
                        style={
                          {
                            '--island-color': island.color,
                            '--island-label-title-font-size': `${ISLAND_LABEL_TITLE_FONT_SIZE_PX}px`,
                            '--island-label-title-line-height': `${ISLAND_LABEL_TITLE_LINE_HEIGHT_PX}px`,
                            '--island-label-kicker-font-size': `${ISLAND_LABEL_KICKER_FONT_SIZE_PX}px`,
                            '--island-label-kicker-line-height': `${ISLAND_LABEL_KICKER_LINE_HEIGHT_PX}px`,
                            left: `${position.x}%`,
                            top: `${position.y}%`,
                            width: `${labelSize.width}px`,
                            height: `${labelSize.height}px`,
                          } as React.CSSProperties
                        }
                      >
                        <span className="island-label-copy">
                          <span
                            className="island-label-title"
                            aria-hidden="true"
                          >
                            {labelSize.titleLines.map((line, lineIndex) => (
                              <span
                                className="island-label-title-line"
                                key={`${island.id}-title-line-${lineIndex}`}
                              >
                                {line}
                              </span>
                            ))}
                          </span>
                          <small aria-hidden="true">{island.kicker}</small>
                        </span>
                        <span
                          className="island-summary"
                          id={summaryId}
                          role="tooltip"
                        >
                          {island.summary}
                        </span>
                      </button>
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
                    const tooltipCitationId = `paper-citations-${paper.id}`;
                    const mappedCitationCount =
                      MAPPED_CITATION_COUNTS.get(paper.id) ?? 0;
                    const diameter = paperNodeDiameter(paper, nodeSizeMode);
                    return (
                      <a
                        href={`papers/${encodeURIComponent(paper.id)}/`}
                        key={paper.id}
                        className={`paper-node paper-node--${paper.role} ${tooltipEdgeClass} ${tooltipVerticalClass} ${isSelected ? 'is-selected' : ''} ${isVisible ? '' : 'is-hidden'}`}
                        style={
                          {
                            '--node-color': island.color,
                            '--node-diameter': `${diameter}px`,
                            left: `${position.x}%`,
                            top: `${position.y}%`,
                          } as React.CSSProperties
                        }
                        onClick={(event) => {
                          if (
                            suppressMapActivationRef.current &&
                            event.detail !== 0
                          ) {
                            event.preventDefault();
                            return;
                          }
                          if (!isUnmodifiedPrimaryClick(event)) return;
                          event.preventDefault();
                          selectPaper(paper.id);
                        }}
                        onPointerEnter={(event) =>
                          positionTooltip(paper.id, event.currentTarget)
                        }
                        onFocus={(event) =>
                          positionTooltip(paper.id, event.currentTarget)
                        }
                        data-paper-node={paper.id}
                        aria-label={`Open ${paper.title}`}
                        aria-describedby={`${authorLabel ? `${tooltipAuthorId} ` : ''}${tooltipCitationId}`}
                        aria-current={isSelected ? 'true' : undefined}
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
                          <small id={tooltipCitationId}>
                            {mappedCitationCount}{' '}
                            {mappedCitationCount === 1
                              ? 'citation'
                              : 'citations'}{' '}
                            from papers on this map
                          </small>
                        </span>
                      </a>
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
                    <a
                      href={`papers/${encodeURIComponent(paper.id)}/`}
                      key={paper.id}
                      className={
                        selectedPaper.id === paper.id ? 'is-selected' : ''
                      }
                      onClick={(event) => {
                        if (!isUnmodifiedPrimaryClick(event)) return;
                        event.preventDefault();
                        selectPaper(paper.id);
                      }}
                      aria-current={
                        selectedPaper.id === paper.id ? 'true' : undefined
                      }
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
                    </a>
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
            <span>
              {nodeSizeMode === 'citations'
                ? 'Dot area follows log-scaled citations on this map; distance still expresses shared ideas.'
                : 'Distance expresses shared ideas—not evidence strength.'}
            </span>
            <span id="map-pan-help">
              {viewMode === 'map'
                ? mapLayoutReady
                  ? 'Drag to move · scroll or pinch to zoom · 0 or F fits the map.'
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

          <p className="screening-note">
            Metadata comes from arXiv. Summaries and placement are
            machine-assisted; inclusion is not endorsement or peer review.
          </p>
        </aside>
      </section>
    </main>
  );
}
