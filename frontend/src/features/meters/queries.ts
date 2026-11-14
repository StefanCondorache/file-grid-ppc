'use client';

import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/api/query-keys';
import { ZONES, type MeterCounters, type Zone } from '@/lib/monitoring/contract';
import { call } from '@/features/demo/api';
import { useLiveRefresh, useRefetchOnResume } from '@/features/observability/queries';

const POLL_MS = 5_000;
/** The readings list counts the whole table server-side: polled less often. */
const READINGS_POLL_MS = 10_000;
const RECENT_PAGE_SIZE = 15;

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const toZone = (v: unknown): Zone | undefined => ZONES.find((z) => z === v);

/** Validates `GET /meters/counters` (and the `meters.counters` event in the same key); null when unusable. */
export function toCounters(raw: unknown): MeterCounters | null {
  if (!isObject(raw)) return null;
  return {
    received: num(raw.received),
    unique: num(raw.unique),
    duplicatesRejected: num(raw.duplicatesRejected),
    lost: typeof raw.lost === 'number' && Number.isFinite(raw.lost) ? raw.lost : null,
    ratePerS: num(raw.ratePerS),
    byZone: (Array.isArray(raw.byZone) ? raw.byZone : [])
      .filter(isObject)
      .flatMap((z) => {
        const zone = toZone(z.zone);
        return zone ? [{ zone, received: num(z.received), ratePerS: num(z.ratePerS) }] : [];
      }),
    at: typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString(),
  };
}

export interface Reading {
  fileId: string | null;
  meterId: string;
  zone: Zone | null;
  readingTime: string | null;
  kwh: number | null;
  sequence: number | null;
  receivedAt: string | null;
  storage: string;
  origin: string;
}

const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** Validates `GET /meter-readings` `{ data, meta }` (backend meters.service.ts). */
export function toReadings(raw: unknown): Reading[] {
  const items = isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  return items.filter(isObject).map((r) => ({
    fileId: typeof r.fileId === 'string' && r.fileId.length > 0 ? r.fileId : null,
    meterId: String(r.meterId ?? '—'),
    zone: toZone(r.zone) ?? null,
    readingTime: iso(r.readingTime),
    kwh: typeof r.kwh === 'number' ? r.kwh : typeof r.kwh === 'string' && r.kwh.trim() !== '' && Number.isFinite(Number(r.kwh)) ? Number(r.kwh) : null,
    sequence: typeof r.sequence === 'number' ? r.sequence : null,
    receivedAt: iso(r.receivedAt),
    storage: String(r.storage ?? '').toLowerCase(),
    origin: String(r.origin ?? ''),
  }));
}

/** Meter counters: fed by the live stream, also polled every 5 s while live (never while paused). */
export function useMeterCounters() {
  const live = useLiveRefresh();
  const query = useQuery({
    queryKey: qk.meters.counters,
    queryFn: () => call<unknown>('GET', '/meters/counters'),
    select: toCounters,
    refetchInterval: live ? POLL_MS : false,
  });
  useRefetchOnResume(live, query.refetch);
  return query;
}

/** The newest readings, polled every 10 s while live. */
export function useRecentReadings() {
  const live = useLiveRefresh();
  const query = useQuery({
    queryKey: qk.meters.readings({ pageSize: RECENT_PAGE_SIZE }),
    queryFn: () => call<unknown>('GET', `/meter-readings?pageSize=${RECENT_PAGE_SIZE}`),
    select: toReadings,
    refetchInterval: live ? READINGS_POLL_MS : false,
  });
  useRefetchOnResume(live, query.refetch);
  return query;
}
