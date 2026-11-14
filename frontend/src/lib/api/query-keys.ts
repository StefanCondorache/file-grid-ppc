import type { Category } from './types';

type Filters = Record<string, string | number | boolean | undefined>;

/** Every query key of the app, defined once (slices never edit this file). */
export const qk = {
  me: ['auth', 'me'] as const,
  files: {
    all: ['files'] as const,
    list: (f: Filters) => ['files', 'list', f] as const,
    detail: (id: string) => ['files', 'detail', id] as const,
    custody: (id: string) => ['files', 'custody', id] as const,
  },
  traces: { one: (id: string) => ['traces', id] as const },
  policies: { all: ['policies'] as const, history: (c: Category) => ['policies', 'history', c] as const },
  guarantees: ['guarantees'] as const,
  alerts: ['alerts'] as const,
  health: ['health'] as const,
  metrics: {
    matrix: (window: string) => ['metrics', 'matrix', window] as const,
    bulkhead: (window: string) => ['metrics', 'bulkhead', window] as const,
  },
  stats: {
    periods: ['stats', 'periods'] as const,
    s1: (periodId: string | null) => ['stats', 's1', periodId] as const,
    s2: (a: string | null, b: string | null) => ['stats', 's2', a, b] as const,
    s3: (periodId: string | null) => ['stats', 's3', periodId] as const,
  },
  meters: {
    counters: ['meters', 'counters'] as const,
    readings: (f: Filters) => ['meters', 'readings', f] as const,
    simulator: ['meters', 'simulator'] as const,
  },
  audit: (f: Filters) => ['audit', f] as const,
  demo: { status: ['demo', 'status'] as const },
} as const;

/** Keys refreshed by the live stream (resynced over REST after every reconnect, FA-8). */
export const STREAM_FED_KEYS = [qk.guarantees, qk.alerts, qk.health, qk.meters.counters, qk.meters.simulator, qk.demo.status, qk.files.all, qk.policies.all] as const;
