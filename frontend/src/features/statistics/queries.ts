'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import {
  STATS_CATEGORIES,
  STORAGE_IDS,
  type Origin,
  type Period,
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

/** `GET /statistics/periods`: entries without an id, label, known kind or start are dropped. */
export function toPeriods(raw: unknown): Period[] {
  return list(record(raw).data).flatMap((entry): Period[] => {
    const p = record(entry);
    const id = str(p.id);
    const label = str(p.label);
    const kind = oneOf(KINDS, p.kind);
    const start = str(p.start);
    if (!id || !label || !kind || !start) return [];
    return [{ id, label, kind, origin: oneOf(ORIGINS, p.origin) ?? (kind === 'peak' ? 'storm' : 'simulator'), start, end: str(p.end) }];
  });
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

/** "Actualizează": refetch every statistics answer, so a storm recorded meanwhile shows up as a peak period. */
export function useRefreshStatistics(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [STATS_ROOT] });
}
