'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import type { operations } from '@/lib/api/schema';
import {
  COMPARISON_METRICS,
  STATS_CATEGORIES,
  STORAGE_IDS,
  type ComparisonFacts,
  type ComparisonRow,
  type Origin,
  type Period,
  type PeriodComparison,
  type StorageFit,
  type StorageFitItem,
  type StorageId,
  type StoragePerformance,
} from './contract';

/**
 * Statistics queries (SC-08). The generated client still types these paths with the OpenAPI proposal, so every answer
 * is read as `unknown` and normalised into the real contract (`contract.ts`): unknown categories and storages are
 * dropped, missing numbers become null, and nothing the server sends is trusted blindly.
 */

/** stats.* freshness (architecture §3): 5 min, plus the screen's "Actualizează" button. */
export const STATS_STALE_MS = 5 * 60_000;
const STATS_ROOT = qk.stats.periods[0];

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : null;
const storageId = (value: unknown): StorageId | null => oneOf(STORAGE_IDS, typeof value === 'string' ? value.toLowerCase() : null);

const KINDS = ['normal', 'peak'] as const;
const ORIGINS: readonly Origin[] = ['manual', 'simulator', 'storm', 'seed'];

/** One labelled period, or null without an id, label, known kind or start. */
function toPeriod(raw: unknown): Period | null {
  const p = record(raw);
  const id = str(p.id);
  const label = str(p.label);
  const kind = oneOf(KINDS, p.kind);
  const start = str(p.start);
  if (!id || !label || !kind || !start) return null;
  return { id, label, kind, origin: oneOf(ORIGINS, p.origin) ?? (kind === 'peak' ? 'storm' : 'simulator'), start, end: str(p.end) };
}

/** `GET /statistics/periods`: entries that are not a labelled period are dropped. */
export function toPeriods(raw: unknown): Period[] {
  return list(record(raw).data).flatMap((entry) => toPeriod(entry) ?? []);
}

function toPerformance(raw: unknown): StoragePerformance[] {
  const s = record(raw);
  const storage = storageId(s.storage);
  if (!storage) return [];
  return [{
    storage,
    samples: Math.max(0, num(s.samples) ?? 0),
    p50Ms: num(s.p50Ms),
    p95Ms: num(s.p95Ms),
    throughputBps: num(s.throughputBps),
    errorRate: num(s.errorRate),
  }];
}

/** `GET /statistics/storage-fit` (S1), items in the categories' order whatever order the server used. */
export function toStorageFit(raw: unknown): StorageFit {
  const body = record(raw);
  const items = list(body.items).flatMap((entry): StorageFitItem[] => {
    const item = record(entry);
    const category = oneOf(STATS_CATEGORIES, item.category);
    const recommendedStorage = storageId(item.recommendedStorage);
    if (!category || !recommendedStorage) return [];
    const interpretation = record(item.interpretation);
    const facts = record(interpretation.facts);
    return [{
      category,
      storages: list(item.storages).flatMap(toPerformance),
      recommendedStorage,
      interpretation: {
        text: str(interpretation.text),
        recommendation: str(interpretation.recommendation),
        facts: {
          ...facts,
          primaryStorage: storageId(facts.primaryStorage),
          fastest: storageId(facts.fastest),
          runnerUp: storageId(facts.runnerUp),
          speedup: num(facts.speedup),
        },
      },
    }];
  });
  items.sort((x, y) => STATS_CATEGORIES.indexOf(x.category) - STATS_CATEGORIES.indexOf(y.category));
  return { periodId: str(body.periodId), items };
}

/** The backend's isolation rule: a category kept its response time when p95 B ≤ 1,5 × A + 50 ms. */
const kept = (row: ComparisonRow) => row.a === null || row.b === null || row.b <= row.a * 1.5 + 50;

/**
 * `GET /statistics/period-comparison` (S2). Rows of unknown categories or metrics are dropped and the rest sorted as
 * the chart and table draw them (category, then metric). Without `isolated`, it is read from the rows: at most one
 * category (the stormed one) lost its response time.
 */
export function toPeriodComparison(raw: unknown): PeriodComparison {
  const body = record(raw);
  const periodA = toPeriod(body.periodA);
  const periodB = toPeriod(body.periodB);
  if (!periodA || !periodB) throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected period comparison from the server');
  const rows = list(body.rows).flatMap((entry): ComparisonRow[] => {
    const r = record(entry);
    const category = oneOf(STATS_CATEGORIES, r.category);
    const metric = oneOf(COMPARISON_METRICS, r.metric);
    return category && metric ? [{ category, metric, a: num(r.a), b: num(r.b), deltaPct: num(r.deltaPct) }] : [];
  });
  const order = (row: ComparisonRow) => STATS_CATEGORIES.indexOf(row.category) * COMPARISON_METRICS.length + COMPARISON_METRICS.indexOf(row.metric);
  rows.sort((x, y) => order(x) - order(y));
  const interpretation = record(body.interpretation);
  const facts = record(interpretation.facts);
  const slowed = rows.filter((r) => r.metric === 'p95Ms' && !kept(r)).length;
  return {
    periodA,
    periodB,
    rows,
    interpretation: {
      text: str(interpretation.text),
      recommendation: str(interpretation.recommendation),
      facts: {
        ...facts,
        factor: num(facts.factor),
        isolated: typeof facts.isolated === 'boolean' ? facts.isolated : slowed <= 1,
        mostAffected: oneOf(STATS_CATEGORIES, facts.mostAffected),
        mostAffectedDeltaPct: num(facts.mostAffectedDeltaPct),
      } satisfies ComparisonFacts,
    },
  };
}

/**
 * The generated client still types the S2 query with the proposal's `periodA` / `periodB`; the real backend (and the
 * mock) read `a` and `b`.
 */
type ComparisonQuery = NonNullable<operations['statistics_periodComparison']['parameters']['query']>;
const comparisonQuery = (a: string, b: string) => ({ a, b }) as ComparisonQuery;

export function usePeriods() {
  return useQuery({
    queryKey: qk.stats.periods,
    queryFn: async () => toPeriods(await unwrap(api.GET('/statistics/periods'))),
    staleTime: STATS_STALE_MS,
  });
}

/** S1 is measured over the last 7 days; the real backend has no period filter for it (`periodId` is always null). */
export function useStorageFit() {
  return useQuery({
    queryKey: qk.stats.s1(null),
    queryFn: async () => toStorageFit(await unwrap(api.GET('/statistics/storage-fit'))),
    staleTime: STATS_STALE_MS,
  });
}

/**
 * S2 for the two chosen periods, cached per pair. The real backend requires both ids, so nothing is asked until the
 * screen has both (a missing peak period means no storm has run yet).
 */
export function usePeriodComparison(a: string | null, b: string | null) {
  return useQuery({
    queryKey: qk.stats.s2(a, b),
    queryFn: async () =>
      toPeriodComparison(await unwrap(api.GET('/statistics/period-comparison', { params: { query: comparisonQuery(a ?? '', b ?? '') } }))),
    enabled: a !== null && b !== null,
    staleTime: STATS_STALE_MS,
  });
}

/** "Actualizează": refetch every statistics answer, so a storm recorded meanwhile shows up as a peak period. */
export function useRefreshStatistics(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [STATS_ROOT] });
}
