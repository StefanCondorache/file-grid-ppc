import type { StreamEvent, StreamEventType } from '@/lib/live/events';
import type { Policy, Role, UserRef } from '@/lib/api/types';
import {
  CATEGORY_IDS, STORAGE_IDS, ZONES, type Alert, type BulkheadPoint, type BulkheadResponse, type CategoryId, type Comparator,
  type GuaranteeMetric, type GuaranteeStatus, type MatrixWindow, type MeterCounters, type MetricsCell, type MetricsMatrix, type SeriesWindow,
  type SimulatorMode, type SimulatorStatus, type StorageHealth, type StorageId, type Zone,
} from '@/lib/monitoring/contract';
import { db as sharedDb, type MockDb } from './db';
import {
  DRONE_TRANSFERS, DUPLICATE_RATIO, FALLBACK_PENALTY, HISTORY_TICKS, JITTER, LOAD_LATENCY, MAX_CONCURRENCY, NORMAL_RATE_PER_S, PROBE_MS, PROFILES,
  SERIES_POINTS, SMOOTHING, STORM_FACTOR, THRESHOLDS, TICK_MS, ZONE_SHARE, seedAlerts, seedMonitoringState, stormPeriodLabel,
  type MonitoringState, type Storm,
} from './seed/monitoring';

/** A running storm as the demo endpoints show it. */
export type StormView = { category: CategoryId; factor: number; startedAt: string; endsAt: string; periodId: string };
/** Answer of a corruption (POST /demo/corruptions). */
export type Corruption = { fileId: string; storage: string; corruptedAt: string };
type PeriodRow = { id: string; label: string; kind: 'normal' | 'peak'; origin: string; start: string; end: string | null };

type Listener = (e: StreamEvent) => void;

const PING_MS = 20_000;

export type ScenarioOptions = {
  /** Shared mock db (default: the app's); tests pass an isolated one. */
  db?: MockDb;
  /** Jitter source (default Math.random); tests fix it. */
  random?: () => number;
  now?: () => number;
};

/** One category in one tick: where it wrote, how fast, and the attempts that failed on its down primary. */
type Sample = { storage: StorageId | null; p95Ms: number | null; opsPerS: number; failed: { storage: StorageId; opsPerS: number } | null };
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
const round2 = (n: number) => Math.round(n * 100) / 100;
const MATRIX_WINDOW_S: Record<MatrixWindow, number> = { '5m': 300, '1h': 3600, '24h': 86_400 };

/** Ops-weighted percentile of per-tick latencies. */
function percentile(xs: { v: number; w: number }[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((n, x) => n + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= q * total) return Math.round(x.v);
  }
  return Math.round(sorted.at(-1)!.v);
}
const OK: Verdict = { state: 'ok', causeCode: null, causeFacts: {} };

function metric(key: string, value: number | string | null, extra: { unit?: string; threshold?: number; comparator?: Comparator } = {}): GuaranteeMetric {
  return {
    key, value: value === null ? null : String(value), unit: extra.unit ?? null,
    threshold: extra.threshold === undefined ? null : String(extra.threshold), comparator: extra.comparator ?? null,
  };
}

/**
 * Mock "server" (6a.8 clock, 6e.1 state). Every TICK_MS it advances the per-category latency series, the meter
 * counters, the storage health and the four guarantees (raising and resolving alerts), and emits the matching stream
 * events. The actions (storms, storages, corruption, simulator) are what the demo endpoints and `window.__fgScenario`
 * call. Persistent parts (storms, counters, simulator, alerts, periods, storage up/down) live in the shared mock db so
 * a reload keeps them; the latency series is transient. Wire shapes follow the real backend (lib/monitoring/contract).
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

  const legacyOf = (c: CategoryId) => Object.keys(LEGACY_CATEGORY).find((k) => LEGACY_CATEGORY[k] === c);
  const ofCategory = (c: CategoryId) => (row: Record<string, unknown>) => row.category === c || row.category === legacyOf(c);

  /** The live policy (the db is seeded with the proposal's ids and labels, so 6d's edits show here). */
  const policy = (c: CategoryId) => d.find<Policy & { maxConcurrency?: number }>('policies', ofCategory(c));
  const route = (c: CategoryId): { primary: StorageId; fallback: StorageId | null } => {
    const p = policy(c);
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

  const baseLatency = () => Object.fromEntries(CATEGORY_IDS.map((c) => [c, PROFILES[c].p95Ms])) as Record<CategoryId, number>;
  let smoothed = baseLatency();

  const sample = (c: CategoryId, mult: number): Sample => {
    const { primary } = route(c);
    const storage = target(c);
    const opsPerS = round2(PROFILES[c].opsPerS * mult);
    // Every write tries the primary first; while it is down those attempts fail fast, then go to the fallback.
    const failed = !up(primary) && opsPerS > 0 ? { storage: primary, opsPerS } : null;
    if (storage === null || opsPerS === 0) return { storage, p95Ms: null, opsPerS: storage === null ? 0 : opsPerS, failed };
    const goal = PROFILES[c].p95Ms * (1 + (Math.max(mult, 1) - 1) * LOAD_LATENCY) * (storage === primary ? 1 : FALLBACK_PENALTY);
    smoothed[c] += (goal - smoothed[c]) * SMOOTHING;
    return { storage, p95Ms: Math.round(smoothed[c] * (1 + (random() * 2 - 1) * JITTER)), opsPerS, failed };
  };

  const samples = (mult: (c: CategoryId) => number) =>
    Object.fromEntries(CATEGORY_IDS.map((c) => [c, sample(c, mult(c))])) as Record<CategoryId, Sample>;

  /** 5 minutes of normal traffic, so charts and the matrix are never empty. */
  const prefill = (): Tick[] => {
    const t0 = now();
    return Array.from({ length: HISTORY_TICKS }, (_, i) => ({ t: t0 - (HISTORY_TICKS - i) * TICK_MS, samples: samples(() => 1) }));
  };
  let history: Tick[] = prefill();

  /** Meter readings stored in the last tick, per zone (the rate shown). */
  const normalStored = () => Object.fromEntries(ZONES.map((z) => [z, NORMAL_RATE_PER_S * ZONE_SHARE[z] * TICK_S])) as Record<Zone, number>;
  let lastStored = normalStored();

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
    const faultOps = Math.round(history.slice(-SERIES_POINTS).reduce((n, tk) => n + tk.samples.fault_records.opsPerS, 0) * TICK_S);
    const faultFacts = { p95Ms: p95, targetMs: THRESHOLDS.faultTargetMs, samples: faultOps, windowMinutes: 1 };
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

    /** Stops the clock and forgets the transient state (latency series); the db's part resets with `db.reset()`. */
    reset(): void {
      api.stop();
      smoothed = baseLatency();
      history = prefill();
      lastStored = normalStored();
      guarantees = judge();
      health = probe();
    },

    /** One step of the mock server. */
    tick(): void {
      for (const storm of state().storms) if (storm.endsAt <= now()) api.stopStorm(storm.category);
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

    /** Who saw it and when (POST /alerts/{id}/acknowledge); a second acknowledgement changes nothing. Null if unknown. */
    acknowledge(alertId: string, by: UserRef, actingAs: Role | null = null): Alert | null {
      const alert = d.find<AlertRow>('alerts', (a) => a.id === alertId);
      if (!alert) return null;
      if (alert.acknowledgedAt !== null) return alert;
      const acked = d.update<AlertRow>('alerts', (a) => a.id === alertId, {
        acknowledgedAt: iso(now()),
        acknowledgedBy: { id: by.id, username: by.username, displayName: by.displayName, role: by.role },
      })!;
      d.audit.append({ actor: by, actingAs, demo: false, action: 'alert_ack', category: alert.category, details: `${alert.causeCode} (${alert.state})` });
      api.emit('alert.updated', acked);
      return acked;
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

    /**
     * Category × storage cells (GET /metrics/matrix) from the kept history: 5 minutes, so longer windows show the
     * same samples. Latencies are of successful operations; failed attempts count in `requests` and `errorRate`.
     */
    matrix(window: MatrixWindow = '5m'): MetricsMatrix {
      const since = now() - MATRIX_WINDOW_S[window] * 1000;
      const ticks = history.filter((tk) => tk.t > since);
      const spanS = Math.max(TICK_S, ticks.length * TICK_S);
      const cells = CATEGORY_IDS.flatMap((category) => STORAGE_IDS.map((storage): MetricsCell => {
        const all = ticks.map((tk) => tk.samples[category]);
        const ok = all.filter((x) => x.storage === storage && x.p95Ms !== null).map((x) => ({ v: x.p95Ms!, w: x.opsPerS }));
        const okN = ok.reduce((n, x) => n + x.w * TICK_S, 0);
        const errN = all.reduce((n, x) => n + (x.failed?.storage === storage ? x.failed.opsPerS * TICK_S : 0), 0);
        if (okN + errN === 0) {
          return { category, storage, requests: 0, noTraffic: true, p50Ms: null, p95Ms: null, p99Ms: null, throughputBps: null, opsPerS: null, errorRate: null };
        }
        const p50Ms = percentile(ok.map((x) => ({ v: x.v * 0.55, w: x.w })), 0.5);
        return {
          category, storage, requests: Math.round(okN + errN), noTraffic: false,
          p50Ms, p95Ms: percentile(ok, 0.95), p99Ms: percentile(ok.map((x) => ({ v: x.v * 1.3, w: x.w })), 0.99),
          throughputBps: p50Ms ? Math.round(PROFILES[category].bytes / (p50Ms / 1000)) : null,
          opsPerS: round2((okN + errN) / spanS),
          errorRate: Math.round((errN / (okN + errN)) * 10_000) / 10_000,
        };
      }));
      return { window, generatedAt: iso(now()), cells };
    },

    /**
     * Bulkhead state (GET /metrics/bulkhead): the series is always the last minute at the tick step, whatever the
     * window; compartments by Little's law (in flight = ops/s × latency), capped by the policy's `maxConcurrency`.
     */
    bulkhead(window: SeriesWindow = '15m'): BulkheadResponse {
      const last = history.at(-1)!.samples;
      const data = CATEGORY_IDS.map((category) => {
        const x = last[category];
        const inFlight = Math.ceil((x.opsPerS * (x.p95Ms ?? 0)) / 1000);
        const max = policy(category)?.maxConcurrency ?? MAX_CONCURRENCY;
        return { category, active: Math.min(inFlight, max), queued: Math.max(0, inFlight - max) };
      });
      return { window, stepS: TICK_S, series: api.series(), data };
    },

    /** Running storms (GET /demo/status). */
    storms(): StormView[] {
      return state().storms.map((s) => ({ ...s, startedAt: iso(s.startedAt), endsAt: iso(s.endsAt) }));
    },

    /**
     * A `factor`× load on one category for `durationS` (BA-61), recorded as a labelled peak period for S2 (BA-64).
     * A running storm on the category is replaced; on meters it is the simulator's peak mode.
     */
    startStorm(category: CategoryName, factor = STORM_FACTOR, durationS = 60): StormView {
      const c = toCategoryId(category);
      if (state().storms.some((s) => s.category === c)) api.stopStorm(c);
      const t = now();
      const storm: Storm = { category: c, factor, startedAt: t, endsAt: t + durationS * 1000, periodId: `p-storm-${c}-${t}` };
      d.insert<PeriodRow>('periods', { id: storm.periodId, label: stormPeriodLabel(t), kind: 'peak', origin: 'storm', start: iso(t), end: null });
      save({ storms: [...state().storms, storm] });
      if (c === 'meter_readings') setSim({ mode: 'peak', ratePerS: NORMAL_RATE_PER_S * factor, stormEndsAt: storm.endsAt });
      api.emit('demo.storm', { category: c, factor, state: 'started', endsAt: iso(storm.endsAt) });
      return api.storms().find((s) => s.category === c)!;
    },

    /** Back to normal load; false when no storm was running on the category. */
    stopStorm(category: CategoryName): boolean {
      const c = toCategoryId(category);
      const storm = state().storms.find((s) => s.category === c);
      if (!storm) return false;
      save({ storms: state().storms.filter((s) => s.category !== c) });
      d.update<PeriodRow>('periods', (p) => p.id === storm.periodId, { end: iso(now()) });
      if (c === 'meter_readings') setSim({ mode: 'normal', ratePerS: NORMAL_RATE_PER_S, stormEndsAt: null });
      api.emit('demo.storm', { category: c, factor: storm.factor, state: 'stopped', endsAt: null });
      return true;
    },

    /**
     * Flips the stored object of a file (POST /demo/corruptions): the db row gets `corruptedAt`; integrity stays as it
     * was until the next download or verification detects it (409 FILE_CORRUPT, then `corrupt`). Null for an unknown file.
     */
    corrupt(fileId: string): Corruption | null {
      const corruptedAt = iso(now());
      const row = d.update<Record<string, unknown>>('files', (f) => f.id === fileId, { corruptedAt });
      return row ? { fileId, storage: String(row.storage ?? '').toLowerCase(), corruptedAt } : null;
    },
  };
  return api;
}

export type Scenario = ReturnType<typeof createScenario>;

/** The single scenario of the running mock. */
export const scenario = createScenario();

// Development only: e2e specs and rehearsals drive it from the console (`__fgScenario.startStorm('fault', 10, 60)`).
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as unknown as { __fgScenario?: Scenario }).__fgScenario = scenario;
}
