import type { StreamEvent, StreamEventType } from '@/lib/live/events';
import type { Policy } from '@/lib/api/types';
import { CATEGORY_IDS, STORAGE_IDS, type BulkheadPoint, type CategoryId, type StorageId } from '@/lib/monitoring/contract';
import { db as sharedDb, type MockDb } from './db';
import { HISTORY_TICKS, JITTER, LOAD_LATENCY, PROFILES, SERIES_POINTS, SMOOTHING, TICK_MS } from './seed/monitoring';

type Listener = (e: StreamEvent) => void;

const PING_MS = 20_000;

export type ScenarioOptions = {
  /** Shared mock db (default: the app's); tests pass an isolated one. */
  db?: MockDb;
  /** Jitter source (default Math.random); tests fix it. */
  random?: () => number;
  now?: () => number;
};

/** One category in one tick: where it wrote and how fast. */
type Sample = { storage: StorageId | null; p95Ms: number | null; opsPerS: number };
type Tick = { t: number; samples: Record<CategoryId, Sample> };

export type Storm = { category: CategoryId; factor: number; startedAt: number; endsAt: number };
type MonitoringState = { id: 'state'; storms: Storm[] };

const LEGACY_CATEGORY: Record<string, CategoryId> = { meter: 'meter_readings', fault: 'fault_records', connection: 'connection_documents', drone: 'drone_videos' };

/** Real category id; the proposal's ids (`fault`, …) are accepted as aliases for rehearsal typing. */
export function toCategoryId(category: string): CategoryId {
  if ((CATEGORY_IDS as readonly string[]).includes(category)) return category as CategoryId;
  const id = LEGACY_CATEGORY[category];
  if (!id) throw new Error(`Unknown category: ${category}`);
  return id;
}

/** Real storage id from an id or a label (`S3` → `s3`). */
export function toStorageId(name: string): StorageId {
  const id = name.toLowerCase();
  if (!(STORAGE_IDS as readonly string[]).includes(id)) throw new Error(`Unknown storage: ${name}`);
  return id as StorageId;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Mock "server" (6a.8 clock, 6e.1 state): every TICK_MS it advances the per-category latency series and emits the
 * matching stream events. Persistent parts (storms) live in the mock db so a reload keeps them; the latency series
 * is transient.
 */
export function createScenario(options: ScenarioOptions = {}) {
  const d = options.db ?? sharedDb;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  d.register<MonitoringState>('monitoring', () => [{ id: 'state', storms: [] }]);

  const listeners = new Set<Listener>();
  let nextId = 1;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const state = (): MonitoringState =>
    d.find<MonitoringState>('monitoring', (r) => r.id === 'state') ?? d.insert<MonitoringState>('monitoring', { id: 'state', storms: [] });
  const save = (patch: Partial<MonitoringState>) => d.update<MonitoringState>('monitoring', (r) => r.id === 'state', patch);

  /** The live policy's primary storage (the db is seeded with the proposal's ids and labels). */
  const route = (c: CategoryId): StorageId => {
    const legacy = Object.keys(LEGACY_CATEGORY).find((k) => LEGACY_CATEGORY[k] === c);
    const p = d.find<Policy>('policies', (x) => (x.category as string) === c || x.category === legacy);
    return p ? toStorageId(p.primaryStorage) : 'db';
  };

  /** Load multiplier: the storm factor of the category, 1 otherwise. */
  const load = (c: CategoryId): number => state().storms.find((s) => s.category === c)?.factor ?? 1;

  const smoothed = Object.fromEntries(CATEGORY_IDS.map((c) => [c, PROFILES[c].p95Ms])) as Record<CategoryId, number>;

  const sample = (c: CategoryId, mult: number): Sample => {
    const goal = PROFILES[c].p95Ms * (1 + (Math.max(mult, 1) - 1) * LOAD_LATENCY);
    smoothed[c] += (goal - smoothed[c]) * SMOOTHING;
    const p95Ms = Math.round(smoothed[c] * (1 + (random() * 2 - 1) * JITTER));
    return { storage: route(c), p95Ms, opsPerS: Math.round(PROFILES[c].opsPerS * mult * 100) / 100 };
  };

  const samples = (mult: (c: CategoryId) => number) =>
    Object.fromEntries(CATEGORY_IDS.map((c) => [c, sample(c, mult(c))])) as Record<CategoryId, Sample>;

  /** 5 minutes of normal traffic, so charts and the matrix are never empty. */
  const prefill = (): Tick[] => {
    const t0 = now();
    return Array.from({ length: HISTORY_TICKS }, (_, i) => ({ t: t0 - (HISTORY_TICKS - i) * TICK_MS, samples: samples(() => 1) }));
  };
  let history: Tick[] = prefill();

  const api = {
    emit(type: StreamEventType, data: unknown): StreamEvent {
      const e: StreamEvent = { type, id: nextId++, data };
      listeners.forEach((l) => l(e));
      return e;
    },
    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): void {
      if (pingTimer) return;
      pingTimer = setInterval(() => api.emit('ping', { serverTime: new Date().toISOString() }), PING_MS);
      tickTimer = setInterval(() => api.tick(), TICK_MS);
    },
    stop(): void {
      if (pingTimer) clearInterval(pingTimer);
      if (tickTimer) clearInterval(tickTimer);
      pingTimer = tickTimer = null;
    },

    /** One step of the mock server. */
    tick(): void {
      history = [...history.slice(-(HISTORY_TICKS - 1)), { t: now(), samples: samples(load) }];
    },

    /** Per-category p95 series of the last minute, on one time axis (GET /metrics/bulkhead). */
    series(): { category: CategoryId; points: BulkheadPoint[] }[] {
      const recent = history.slice(-SERIES_POINTS);
      return CATEGORY_IDS.map((category) => ({
        category,
        points: recent.map((tk) => ({ t: iso(tk.t), p95Ms: tk.samples[category].p95Ms, opsPerS: tk.samples[category].opsPerS })),
      }));
    },

    /** A `factor`× load on one category for `durationS` (BA-61); a running storm on it is replaced. */
    startStorm(category: CategoryId | string, factor = 10, durationS = 60): Storm {
      const c = toCategoryId(category);
      const t = now();
      const storm: Storm = { category: c, factor, startedAt: t, endsAt: t + durationS * 1000 };
      save({ storms: [...state().storms.filter((s) => s.category !== c), storm] });
      api.emit('demo.storm', { category: c, factor, state: 'started', endsAt: iso(storm.endsAt) });
      return storm;
    },

    /** Back to normal load; false when no storm was running on the category. */
    stopStorm(category: CategoryId | string): boolean {
      const c = toCategoryId(category);
      const storm = state().storms.find((s) => s.category === c);
      if (!storm) return false;
      save({ storms: state().storms.filter((s) => s.category !== c) });
      api.emit('demo.storm', { category: c, factor: storm.factor, state: 'stopped', endsAt: null });
      return true;
    },
  };
  return api;
}

export type Scenario = ReturnType<typeof createScenario>;

/** The single scenario of the running mock. */
export const scenario = createScenario();
