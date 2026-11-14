import type { StreamEvent, StreamEventType } from '@/lib/live/events';
import type { Policy } from '@/lib/api/types';
import {
  CATEGORY_IDS, STORAGE_IDS, ZONES, type Alert, type BulkheadPoint, type CategoryId, type Comparator, type GuaranteeMetric,
  type GuaranteeStatus, type MeterCounters, type SimulatorMode, type SimulatorStatus, type StorageHealth, type StorageId, type Zone,
} from '@/lib/monitoring/contract';
import { db as sharedDb, type MockDb } from './db';
import {
  DRONE_TRANSFERS, DUPLICATE_RATIO, HISTORY_TICKS, JITTER, LOAD_LATENCY, NORMAL_RATE_PER_S, PROBE_MS, PROFILES,
  SERIES_POINTS, SMOOTHING, STORM_FACTOR, THRESHOLDS, TICK_MS, ZONE_SHARE, seedAlerts, seedMonitoringState, type MonitoringState, type Storm,
} from './seed/monitoring';

export type { Storm };

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

type AlertRow = Alert & Record<string, unknown>;
type Verdict = Pick<GuaranteeStatus, 'state' | 'causeCode' | 'causeFacts'>;

/** Accepted names: real ids, plus the proposal's ids and labels as aliases for rehearsal typing. */
export type CategoryName = CategoryId | 'meter' | 'fault' | 'connection' | 'drone';
export type StorageName = StorageId | 'S3' | 'FTP' | 'DB';

const LABEL: Record<StorageId, 'S3' | 'FTP' | 'DB'> = { s3: 'S3', ftp: 'FTP', db: 'DB' };
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
const TICK_S = TICK_MS / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const OK: Verdict = { state: 'ok', causeCode: null, causeFacts: {} };

function metric(key: string, value: number | string | null, extra: { unit?: string; threshold?: number; comparator?: Comparator } = {}): GuaranteeMetric {
  return {
    key, value: value === null ? null : String(value), unit: extra.unit ?? null,
    threshold: extra.threshold === undefined ? null : String(extra.threshold), comparator: extra.comparator ?? null,
  };
}

/**
 * Mock "server" (6a.8 clock, 6e.1 state): every TICK_MS it advances the per-category latency series and emits the
 * matching stream events. Persistent parts (storms) live in the mock db so a reload keeps them; the latency series
 * is transient.
 */
export function createScenario(options: ScenarioOptions = {}) {
  const d = options.db ?? sharedDb;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  d.register<MonitoringState>('monitoring', () => [seedMonitoringState()]);
  d.register<AlertRow>('alerts', () => seedAlerts(now()) as AlertRow[]);

  const listeners = new Set<Listener>();
  let nextId = 1;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const state = (): MonitoringState =>
    d.find<MonitoringState>('monitoring', (r) => r.id === 'state') ?? d.insert<MonitoringState>('monitoring', seedMonitoringState());
  const save = (patch: Partial<MonitoringState>) => d.update<MonitoringState>('monitoring', (r) => r.id === 'state', patch);

  /** The live policy's storages (the db is seeded with the proposal's ids and labels). */
  const route = (c: CategoryId): { primary: StorageId; fallback: StorageId | null } => {
    const legacy = Object.keys(LEGACY_CATEGORY).find((k) => LEGACY_CATEGORY[k] === c);
    const p = d.find<Policy>('policies', (x) => (x.category as string) === c || x.category === legacy);
    return { primary: p ? toStorageId(p.primaryStorage) : 'db', fallback: p?.fallbackStorage ? toStorageId(p.fallbackStorage) : null };
  };
  const up = (s: StorageId | null): s is StorageId => s !== null && d.storage.status(LABEL[s]) !== 'down';
  /** Where the category writes now: its primary, else its fallback, else nowhere. */
  const target = (c: CategoryId): StorageId | null => {
    const { primary, fallback } = route(c);
    return up(primary) ? primary : up(fallback) ? fallback : null;
  };

  /** Load multiplier: meters follow the simulator rate (a meter storm is its peak mode); others their storm factor. */
  const load = (c: CategoryId): number =>
    c === 'meter_readings' ? state().simulator.ratePerS / NORMAL_RATE_PER_S : state().storms.find((s) => s.category === c)?.factor ?? 1;

  const smoothed = Object.fromEntries(CATEGORY_IDS.map((c) => [c, PROFILES[c].p95Ms])) as Record<CategoryId, number>;

  const sample = (c: CategoryId, mult: number): Sample => {
    const storage = target(c);
    const opsPerS = Math.round(PROFILES[c].opsPerS * mult * 100) / 100;
    if (storage === null || opsPerS === 0) return { storage, p95Ms: null, opsPerS: storage === null ? 0 : opsPerS };
    const goal = PROFILES[c].p95Ms * (1 + (Math.max(mult, 1) - 1) * LOAD_LATENCY);
    smoothed[c] += (goal - smoothed[c]) * SMOOTHING;
    return { storage, p95Ms: Math.round(smoothed[c] * (1 + (random() * 2 - 1) * JITTER)), opsPerS };
  };

  const samples = (mult: (c: CategoryId) => number) =>
    Object.fromEntries(CATEGORY_IDS.map((c) => [c, sample(c, mult(c))])) as Record<CategoryId, Sample>;

  /** 5 minutes of normal traffic, so charts and the matrix are never empty. */
  const prefill = (): Tick[] => {
    const t0 = now();
    return Array.from({ length: HISTORY_TICKS }, (_, i) => ({ t: t0 - (HISTORY_TICKS - i) * TICK_MS, samples: samples(() => 1) }));
  };
  let history: Tick[] = prefill();

  const legacyOf = (c: CategoryId) => Object.keys(LEGACY_CATEGORY).find((k) => LEGACY_CATEGORY[k] === c);
  const ofCategory = (c: CategoryId) => (row: Record<string, unknown>) => row.category === c || row.category === legacyOf(c);

  /** Meter readings stored in the last tick, per zone (the rate shown). */
  let lastStored: Record<Zone, number> = Object.fromEntries(ZONES.map((z) => [z, NORMAL_RATE_PER_S * ZONE_SHARE[z] * TICK_S])) as Record<Zone, number>;

  /** The simulator sends; readings are stored when their storage is up, else they wait in its queue. lost = sent − acked − queued = 0. */
  const advanceMeters = (storageUp: boolean) => {
    const st = state();
    const sentExact = st.carry.sent + st.simulator.ratePerS * TICK_S;
    const sent = Math.floor(sentExact);
    const accepted = storageUp ? sent + st.queueDepth : 0;
    const dupExact = st.carry.duplicates + accepted * DUPLICATE_RATIO;
    const duplicates = Math.floor(dupExact);
    const split = { muntenia: Math.round(accepted * ZONE_SHARE.muntenia), banat: Math.round(accepted * ZONE_SHARE.banat), dobrogea: 0 };
    split.dobrogea = accepted - split.muntenia - split.banat;
    lastStored = split;
    save({
      received: st.received + accepted + duplicates,
      duplicatesRejected: st.duplicatesRejected + duplicates,
      byZone: Object.fromEntries(ZONES.map((z) => [z, st.byZone[z] + split[z]])) as Record<Zone, number>,
      carry: { sent: sentExact - sent, duplicates: dupExact - duplicates },
      queueDepth: storageUp ? 0 : st.queueDepth + sent,
    });
  };

  const unique = (st: MonitoringState) => ZONES.reduce((n, z) => n + st.byZone[z], 0);

  const simulator = (): SimulatorStatus => {
    const st = state();
    const storm = st.storms.find((s) => s.category === 'meter_readings');
    return {
      mode: st.simulator.mode,
      ratePerS: st.simulator.ratePerS,
      normalRatePerS: NORMAL_RATE_PER_S,
      peakRatePerS: NORMAL_RATE_PER_S * (storm?.factor ?? STORM_FACTOR),
      queueDepth: st.queueDepth,
      stormEndsAt: st.simulator.stormEndsAt === null ? null : iso(st.simulator.stormEndsAt),
      sentUnique: unique(st) + st.queueDepth,
      ackedUnique: unique(st),
    };
  };

  /** The backend's formula: lost = sent − acked − queued (readings wait in the queue, so it stays 0). */
  const counters = (): MeterCounters => {
    const st = state();
    const sim = simulator();
    return {
      received: st.received,
      unique: sim.ackedUnique,
      duplicatesRejected: st.duplicatesRejected,
      lost: Math.max(0, sim.sentUnique - sim.ackedUnique - sim.queueDepth),
      ratePerS: round1(ZONES.reduce((n, z) => n + lastStored[z], 0) / TICK_S),
      byZone: ZONES.map((zone) => ({ zone, received: st.byZone[zone], ratePerS: round1(lastStored[zone] / TICK_S) })),
      at: iso(now()),
    };
  };

  const setSim = (sim: MonitoringState['simulator']) => {
    save({ simulator: sim });
    api.emit('simulator.status', simulator());
  };

  /** The four business guarantees (backend/src/guarantees), judged on the latest tick. */
  const judge = (): GuaranteeStatus[] => {
    const updatedAt = iso(now());
    const last = history.at(-1)!.samples;

    const meterCounters = counters();
    const meter: Verdict = meterCounters.lost !== null && meterCounters.lost > THRESHOLDS.meterLostMax
      ? { state: 'violated', causeCode: 'METER_READINGS_LOST', causeFacts: { lost: meterCounters.lost, max: THRESHOLDS.meterLostMax } }
      : OK;

    const p95 = last.fault_records.p95Ms;
    const samples = Math.round(history.slice(-SERIES_POINTS).reduce((n, tk) => n + tk.samples.fault_records.opsPerS, 0) * (TICK_MS / 1000));
    const faultFacts = { p95Ms: p95, targetMs: THRESHOLDS.faultTargetMs, samples, windowMinutes: 1 };
    const fault: Verdict = p95 === null || p95 <= THRESHOLDS.faultTargetMs
      ? OK
      : { state: p95 > THRESHOLDS.faultViolatedMs ? 'violated' : 'at_risk', causeCode: 'FAULT_P95_ABOVE_TARGET', causeFacts: faultFacts };

    const docs = d.list<Record<string, unknown>>('files').filter(ofCategory('connection_documents'));
    const encrypted = docs.filter((f) => f.encryptedAtRest !== false).length;
    const encryptedPct = docs.length === 0 ? 100 : Math.round((encrypted / docs.length) * 10_000) / 100;
    const today = new Date(now()).setHours(0, 0, 0, 0);
    const unmasked = d.list<{ action?: string; at?: string }>('audit')
      .filter((a) => (a.action === 'reveal' || a.action === 'reveal_pii') && Date.parse(a.at ?? '') >= today).length;
    const connection: Verdict = encryptedPct < THRESHOLDS.connectionEncryptedPct
      ? { state: 'violated', causeCode: 'CONNECTION_NOT_ENCRYPTED', causeFacts: { encryptedPct, unencrypted: docs.length - encrypted, minPct: THRESHOLDS.connectionEncryptedPct } }
      : unmasked > THRESHOLDS.connectionUnmaskMax
        ? { state: 'at_risk', causeCode: 'CONNECTION_UNMASK_SPIKE', causeFacts: { unmaskEventsToday: unmasked, max: THRESHOLDS.connectionUnmaskMax } }
        : OK;

    const uploads = d.list<{ category?: string; status?: string }>('uploads').filter((u) => u.category === 'drone_videos');
    const completed = DRONE_TRANSFERS.completed + uploads.filter((u) => u.status === 'completed').length;
    const failed = DRONE_TRANSFERS.failed + uploads.filter((u) => u.status === 'failed' || u.status === 'expired').length;
    const successRate = completed + failed === 0 ? null : Math.round((completed / (completed + failed)) * 10_000) / 10_000;
    const droneFacts = { successRate, min: THRESHOLDS.droneSuccessMin, failed, completed, windowMinutes: 60 };
    const drone: Verdict = successRate === null || successRate >= THRESHOLDS.droneSuccessAtRisk
      ? OK
      : successRate < THRESHOLDS.droneSuccessMin
        ? { state: 'violated', causeCode: 'DRONE_SUCCESS_BELOW_TARGET', causeFacts: droneFacts }
        : { state: 'at_risk', causeCode: 'DRONE_SUCCESS_NEAR_TARGET', causeFacts: droneFacts };

    return [
      {
        category: 'meter_readings', ...meter, updatedAt, metrics: [
          metric('received', meterCounters.received),
          metric('unique', meterCounters.unique),
          metric('duplicatesRejected', meterCounters.duplicatesRejected),
          metric('lost', meterCounters.lost, { threshold: THRESHOLDS.meterLostMax, comparator: 'lte' }),
        ],
      },
      { category: 'fault_records', ...fault, metrics: [metric('uploadToAvailableP95Ms', p95, { unit: 'ms', threshold: THRESHOLDS.faultTargetMs, comparator: 'lte' })], updatedAt },
      {
        category: 'connection_documents', ...connection, updatedAt, metrics: [
          metric('encryptedPct', encryptedPct, { unit: '%', threshold: THRESHOLDS.connectionEncryptedPct, comparator: 'gte' }),
          metric('unmaskEventsToday', unmasked, { threshold: THRESHOLDS.connectionUnmaskMax, comparator: 'lte' }),
          metric('lastAuditCheckAt', updatedAt),
        ],
      },
      {
        category: 'drone_videos', ...drone, updatedAt, metrics: [
          metric('transfersCompleted', completed),
          metric('transfersResumed', DRONE_TRANSFERS.resumed),
          metric('transfersFailed', failed),
          metric('successRate', successRate, { threshold: THRESHOLDS.droneSuccessMin, comparator: 'gte' }),
        ],
      },
    ];
  };

  /** Alert transitions (backend/src/guarantees/alerts.service.ts): leave ok → raised; change → updated; back to ok → resolved. */
  const transition = (g: GuaranteeStatus) => {
    const open = d.find<AlertRow>('alerts', (a) => a.category === g.category && a.state !== 'resolved');
    if (g.state === 'ok') {
      if (open) api.emit('alert.updated', d.update<AlertRow>('alerts', (a) => a.id === open.id, { state: 'resolved', resolvedAt: iso(now()) }));
      return;
    }
    const causeCode = g.causeCode ?? 'GUARANTEE_AT_RISK';
    if (!open) {
      const raised: AlertRow = {
        id: crypto.randomUUID(), category: g.category, state: g.state, raisedAt: iso(now()), resolvedAt: null, causeCode,
        causeFacts: g.causeFacts, traceId: null, acknowledgedAt: null, acknowledgedBy: null,
      };
      api.emit('alert.raised', d.insert('alerts', raised));
      return;
    }
    if (open.state === g.state && open.causeCode === causeCode) return;
    api.emit('alert.updated', d.update<AlertRow>('alerts', (a) => a.id === open.id, { state: g.state, causeCode, causeFacts: g.causeFacts }));
  };

  let guarantees = judge();

  /** Health-monitor view of the storages; their up/down state is the shared db's (uploads read it too). */
  const probe = (): StorageHealth[] => STORAGE_IDS.map((storage) => {
    const status = d.storage.status(LABEL[storage]);
    return {
      storage, status, lastCheckAt: iso(now()),
      latencyMs: status === 'down' ? null : Math.max(1, Math.round(PROBE_MS[storage] * (1 + (random() * 2 - 1) * 0.2))),
      circuitState: status === 'down' ? 'open' : status === 'degraded' ? 'half_open' : 'closed',
    };
  });
  let health = probe();

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
      advanceMeters(target('meter_readings') !== null);
      api.emit('meters.counters', counters());
      guarantees = judge();
      guarantees.forEach(transition);
      health = probe();
      api.emit('storage.health', { items: health });
      api.emit('guarantees.status', { items: guarantees });
    },

    /** Meter counters (GET /meters/counters); `lost` is always 0. */
    counters,

    /** Meter simulator (GET /meters/simulator). */
    simulator,

    /** Simulator mode (PUT /meters/simulator); leaving `peak` ends a meter storm. */
    setSimulator(mode: SimulatorMode, ratePerS?: number): SimulatorStatus {
      if (mode !== 'peak' && state().storms.some((s) => s.category === 'meter_readings')) api.stopStorm('meter_readings');
      const rate = { normal: NORMAL_RATE_PER_S, peak: NORMAL_RATE_PER_S * STORM_FACTOR, custom: ratePerS ?? state().simulator.ratePerS, stopped: 0 }[mode];
      setSim({ mode, ratePerS: rate, stormEndsAt: mode === 'peak' ? state().simulator.stormEndsAt : null });
      return simulator();
    },

    /** Latest storage health (GET /storage-health). */
    storageHealth(): StorageHealth[] {
      return health;
    },

    /** Stops or starts a storage (`S3`/`s3`, …): the shared db changes, so uploads fall back; health is pushed now. */
    setStorage(name: StorageName, up: boolean): StorageHealth[] {
      d.storage.set(LABEL[toStorageId(name)], up ? 'ok' : 'down');
      health = probe();
      api.emit('storage.health', { items: health });
      return health;
    },

    /** Latest guarantee statuses (GET /guarantees). */
    guarantees(): GuaranteeStatus[] {
      return guarantees;
    },

    /** Alerts, newest first (GET /alerts; `active` = not resolved). */
    alerts(filter: 'active' | 'resolved' | 'all' = 'all'): Alert[] {
      return d.list<AlertRow>('alerts')
        .filter((a) => filter === 'all' || (filter === 'active') === (a.state !== 'resolved'))
        .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
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
    startStorm(category: CategoryName, factor = 10, durationS = 60): Storm {
      const c = toCategoryId(category);
      const t = now();
      const storm: Storm = { category: c, factor, startedAt: t, endsAt: t + durationS * 1000 };
      save({ storms: [...state().storms.filter((s) => s.category !== c), storm] });
      if (c === 'meter_readings') setSim({ mode: 'peak', ratePerS: NORMAL_RATE_PER_S * factor, stormEndsAt: storm.endsAt });
      api.emit('demo.storm', { category: c, factor, state: 'started', endsAt: iso(storm.endsAt) });
      return storm;
    },

    /** Back to normal load; false when no storm was running on the category. */
    stopStorm(category: CategoryName): boolean {
      const c = toCategoryId(category);
      const storm = state().storms.find((s) => s.category === c);
      if (!storm) return false;
      save({ storms: state().storms.filter((s) => s.category !== c) });
      if (c === 'meter_readings') setSim({ mode: 'normal', ratePerS: NORMAL_RATE_PER_S, stormEndsAt: null });
      api.emit('demo.storm', { category: c, factor: storm.factor, state: 'stopped', endsAt: null });
      return true;
    },
  };
  return api;
}

export type Scenario = ReturnType<typeof createScenario>;

/** The single scenario of the running mock. */
export const scenario = createScenario();
