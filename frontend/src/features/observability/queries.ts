'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { CATEGORY_IDS, STORAGE_IDS, type CategoryId, type MatrixWindow, type MetricsCell, type SeriesWindow, type StorageId } from '@/lib/monitoring/contract';
import { useAppStore } from '@/stores/app-store';

/** Window aggregates are polled, not streamed (frontend-architecture §3): every 5 s while live and visible. */
export const MATRIX_POLL_MS = 5_000;

/** The windows `GET /metrics/matrix` accepts (backend MATRIX_WINDOWS), in picker order. */
export const MATRIX_WINDOWS: readonly MatrixWindow[] = ['5m', '1h', '24h'];

/** The window from the URL (`/observability?window=1h`), or the default. */
export function toMatrixWindow(raw: string | null | undefined): MatrixWindow {
  return MATRIX_WINDOWS.find((w) => w === raw) ?? '5m';
}

/** The OpenAPI proposal's ids, still accepted (docs/api.md differences). */
const LEGACY_CATEGORY: Record<string, CategoryId> = {
  meter: 'meter_readings',
  fault: 'fault_records',
  connection: 'connection_documents',
  drone: 'drone_videos',
};

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toCategory(raw: unknown): CategoryId | undefined {
  const id = String(raw);
  return (CATEGORY_IDS as readonly string[]).includes(id) ? (id as CategoryId) : LEGACY_CATEGORY[id];
}

/** The real ids (`s3`, `ftp`, `db`) and the proposal's labels (`S3`, `FTP`, `DB`). */
function toStorage(raw: unknown): StorageId | undefined {
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  return STORAGE_IDS.find((s) => s === id);
}

/** A validated matrix: `window` and `generatedAt` are null when the server did not send a value we can trust. */
export interface MatrixView {
  window: MatrixWindow | null;
  generatedAt: string | null;
  cells: MetricsCell[];
}

/**
 * Validates `GET /metrics/matrix` (never trust external data): unknown categories or storages are dropped, numbers
 * that are not finite become null, a cell without a `noTraffic` flag has none when it served no request, and a window
 * or timestamp we cannot use becomes null.
 */
export function toMetricsMatrix(raw: unknown): MatrixView {
  if (!isObject(raw)) return { window: null, generatedAt: null, cells: [] };
  const cells: MetricsCell[] = [];
  for (const item of Array.isArray(raw.cells) ? raw.cells : []) {
    if (!isObject(item)) continue;
    const category = toCategory(item.category);
    const storage = toStorage(item.storage);
    if (!category || !storage) continue;
    const requests = Math.max(0, finite(item.requests) ?? 0);
    cells.push({
      category,
      storage,
      requests,
      noTraffic: typeof item.noTraffic === 'boolean' ? item.noTraffic : requests === 0,
      p50Ms: finite(item.p50Ms),
      p95Ms: finite(item.p95Ms),
      p99Ms: finite(item.p99Ms),
      throughputBps: finite(item.throughputBps),
      opsPerS: finite(item.opsPerS),
      errorRate: finite(item.errorRate),
    });
  }
  return {
    window: MATRIX_WINDOWS.find((w) => w === raw.window) ?? null,
    // Only a parseable timestamp: formatting an invalid date throws.
    generatedAt: typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)) ? raw.generatedAt : null,
    cells,
  };
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the page is visible (`document.visibilityState`); the server render assumes it is. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => true);
}

/**
 * Whether polled data should refresh on its own: "Actualizări live" is not paused (A11Y-14) and the tab is visible
 * (frontend-architecture §3: "only while mounted, visible and live updates not paused").
 */
export function useLiveRefresh(): boolean {
  const paused = useAppStore((s) => s.livePaused);
  const visible = usePageVisible();
  return !paused && visible;
}

/** When refreshing resumes (live updates back on, or the tab visible again), fetch the latest snapshot at once. */
export function useRefetchOnResume(live: boolean, refetch: () => unknown): void {
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) void refetch();
    wasLive.current = live;
  }, [live, refetch]);
}

/**
 * Category × storage latency, throughput and error rate for a window (BA-43). Polled every 5 s while live; changing
 * the window keeps the previous matrix on screen until the new one arrives (`keepPreviousData`, FE-09: no jumps).
 */
export function useMetricsMatrix(window: MatrixWindow) {
  const live = useLiveRefresh();
  const query = useQuery({
    queryKey: qk.metrics.matrix(window),
    queryFn: () => unwrap(api.GET('/metrics/matrix', { params: { query: { window } } })),
    select: toMetricsMatrix,
    staleTime: 0,
    refetchInterval: live ? MATRIX_POLL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  useRefetchOnResume(live, query.refetch);
  return query;
}

/** The windows `GET /metrics/bulkhead` accepts (backend SERIES_WINDOWS), in picker order; the backend default is 15m. */
export const SERIES_WINDOWS: readonly SeriesWindow[] = ['5m', '15m', '1h'];

export interface BulkheadSeriesView {
  category: CategoryId;
  points: { t: string; p95Ms: number | null; opsPerS: number }[];
}

/** A validated bulkhead answer: p95 series per category plus this replica's compartments. */
export interface BulkheadView {
  series: BulkheadSeriesView[];
  compartments: { category: CategoryId; active: number; queued: number }[];
}

/** Validates `GET /metrics/bulkhead` (backend monitoring.controller.ts): unknown categories and bad points are dropped. */
export function toBulkhead(raw: unknown): BulkheadView {
  if (!isObject(raw)) return { series: [], compartments: [] };
  const series: BulkheadSeriesView[] = [];
  for (const item of Array.isArray(raw.series) ? raw.series : []) {
    if (!isObject(item)) continue;
    const category = toCategory(item.category);
    if (!category) continue;
    const points = (Array.isArray(item.points) ? item.points : [])
      .filter((p): p is Loose => isObject(p) && typeof p.t === 'string' && !Number.isNaN(Date.parse(p.t)))
      .map((p) => ({ t: p.t as string, p95Ms: finite(p.p95Ms), opsPerS: Math.max(0, finite(p.opsPerS) ?? 0) }));
    series.push({ category, points });
  }
  series.sort((a, b) => CATEGORY_IDS.indexOf(a.category) - CATEGORY_IDS.indexOf(b.category));
  const compartments: BulkheadView['compartments'] = [];
  for (const item of Array.isArray(raw.data) ? raw.data : []) {
    if (!isObject(item)) continue;
    const category = toCategory(item.category);
    if (!category) continue;
    compartments.push({ category, active: Math.max(0, finite(item.active) ?? 0), queued: Math.max(0, finite(item.queued) ?? 0) });
  }
  return { series, compartments };
}

/** p95 per category on one time axis plus the compartments (BA-44); polled every 5 s while live, like the matrix. */
export function useBulkhead(window: SeriesWindow = '15m') {
  const live = useLiveRefresh();
  const query = useQuery({
    queryKey: qk.metrics.bulkhead(window),
    queryFn: () => unwrap(api.GET('/metrics/bulkhead', { params: { query: { window } } })),
    select: toBulkhead,
    staleTime: 0,
    refetchInterval: live ? MATRIX_POLL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  useRefetchOnResume(live, query.refetch);
  return query;
}
