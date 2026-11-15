'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext } from 'react';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { ro } from '@/lib/i18n/ro';
import type { SimulatorMode, SimulatorStatus } from '@/lib/monitoring/contract';
import { useLiveRefresh } from '@/features/observability/queries';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Fn = (path: string, init?: { body?: unknown; params?: unknown }) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

/**
 * One call to the real backend through the typed client's transport (CSRF header), for the demo routes
 * whose real paths differ from the generated proposal schema (e.g. `POST /demo/storages/{storage}/{action}`).
 */
export function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const client = api as unknown as Record<Method, Fn>;
  return unwrap(client[method](path, body === undefined ? undefined : { body })) as Promise<T>;
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const MODES: readonly SimulatorMode[] = ['normal', 'peak', 'custom', 'stopped'];

/** Validates a simulator status (GET /meters/simulator, the storm and PUT answers); null when unusable. */
export function toSimulator(raw: unknown): SimulatorStatus | null {
  if (!isObject(raw)) return null;
  const mode = MODES.find((m) => m === raw.mode);
  if (!mode) return null;
  return {
    mode,
    ratePerS: num(raw.ratePerS),
    normalRatePerS: num(raw.normalRatePerS),
    peakRatePerS: num(raw.peakRatePerS),
    queueDepth: num(raw.queueDepth),
    stormEndsAt: typeof raw.stormEndsAt === 'string' && !Number.isNaN(Date.parse(raw.stormEndsAt)) ? raw.stormEndsAt : null,
    sentUnique: num(raw.sentUnique),
    ackedUnique: num(raw.ackedUnique),
  };
}

export interface DemoStatus {
  demoMode: boolean;
  simulator: SimulatorStatus | null;
  storm: { category: string; endsAt: string | null } | null;
}

/** Validates `GET /demo/status` `{ demoMode, simulator, storm, storages }` (backend demo.service.ts). */
export function toDemoStatus(raw: unknown): DemoStatus {
  if (!isObject(raw)) return { demoMode: false, simulator: null, storm: null };
  const storm = isObject(raw.storm)
    ? { category: String(raw.storm.category ?? 'meter_readings'), endsAt: typeof raw.storm.endsAt === 'string' && !Number.isNaN(Date.parse(raw.storm.endsAt)) ? raw.storm.endsAt : null }
    : null;
  return { demoMode: raw.demoMode === true, simulator: toSimulator(raw.simulator), storm };
}

const POLL_MS = 5_000;

/** Demo status (storm, simulator); live-fed by the stream, also polled every 5 s while live for the countdown. */
export function useDemoStatus(enabled = true) {
  const live = useLiveRefresh();
  return useQuery({
    queryKey: qk.demo.status,
    queryFn: () => call<unknown>('GET', '/demo/status'),
    select: toDemoStatus,
    enabled,
    refetchInterval: live ? POLL_MS : false,
  });
}

/** The meter simulator (GET /meters/simulator). */
export function useSimulator(enabled = true) {
  const live = useLiveRefresh();
  return useQuery({
    queryKey: qk.meters.simulator,
    queryFn: () => call<unknown>('GET', '/meters/simulator'),
    select: toSimulator,
    enabled,
    refetchInterval: live ? POLL_MS : false,
  });
}

export type LogEntry = { id: number; at: string; ok: boolean; text: string };
export type Report = (ok: boolean, text: string) => void;

export const ReportContext = createContext<Report>(() => {});

/** Romanian text of a failed demo action: the demo catalogue, the app catalogue, then the server's safe message. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return ro.errors.generic;
  const demoErrors = ro.demo.errors as Record<string, string>;
  const appErrors = ro.errors as Record<string, string>;
  return ro.demo.failed(demoErrors[error.code] ?? appErrors[error.code] ?? error.message, error.code);
}

/** Runs a demo action: reports the outcome (visible log + announcer) and refreshes what it may have changed. */
export function useRunAction() {
  const report = useContext(ReportContext);
  const qc = useQueryClient();
  return useCallback(
    async <T,>(action: () => Promise<T>, okText: (result: T) => string): Promise<T | null> => {
      try {
        const result = await action();
        report(true, okText(result));
        return result;
      } catch (error) {
        report(false, errorText(error));
        return null;
      } finally {
        for (const key of [qk.demo.status, qk.meters.simulator, qk.meters.counters, qk.health, qk.guarantees]) {
          void qc.invalidateQueries({ queryKey: key });
        }
      }
    },
    [qc, report],
  );
}
