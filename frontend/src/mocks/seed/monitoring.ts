import type { Alert, CategoryId, SimulatorMode, StorageId, Zone } from '@/lib/monitoring/contract';

/** Monitoring seed and the scenario's load model (Task 6e.1). Mock data only, never real measurements. */

/** One scenario step; also the step of the bulkhead series. */
export const TICK_MS = 2_000;
/** Points per bulkhead series: one per tick, the last minute. */
export const SERIES_POINTS = 30;
/** Ticks kept for the category × storage matrix: 5 minutes (longer windows reuse them). */
export const HISTORY_TICKS = 150;

export type CategoryProfile = {
  /** p95 in ms at normal load on the primary storage. */
  p95Ms: number;
  /** Operations per second at normal load (meters: simulator batches of 10 readings). */
  opsPerS: number;
  /** Average bytes per operation, for the throughput column. */
  bytes: number;
};

export const PROFILES: Record<CategoryId, CategoryProfile> = {
  meter_readings: { p95Ms: 140, opsPerS: 1, bytes: 24 * 1024 },
  fault_records: { p95Ms: 600, opsPerS: 0.5, bytes: 4 * 1024 ** 2 },
  connection_documents: { p95Ms: 420, opsPerS: 0.2, bytes: 1.5 * 1024 ** 2 },
  drone_videos: { p95Ms: 760, opsPerS: 0.1, bytes: 16 * 1024 ** 2 },
};

/** Share of the extra load that becomes latency: p95 = base × (1 + (factor − 1) × LOAD_LATENCY); 10× faults ≈ 3,3 s. */
export const LOAD_LATENCY = 0.5;
/** Each tick closes this share of the gap to the target latency: a visible climb, not a jump. */
export const SMOOTHING = 0.5;
/** ± share of jitter around the smoothed latency. */
export const JITTER = 0.04;
/** Writes that land on the fallback storage are slower. */
export const FALLBACK_PENALTY = 1.25;
/** Bulkhead compartment size when the policy has no `maxConcurrency` (the uploads mock uses the same default). */
export const MAX_CONCURRENCY = 8;
/** Health-probe latency per storage when it is up. */
export const PROBE_MS: Record<StorageId, number> = { s3: 14, ftp: 38, db: 3 };

/** Guarantee thresholds of the mock. Faults: "available to dispatch" target 2 s (PRD §3); above it the card is at risk. */
export const THRESHOLDS = {
  faultTargetMs: 2_000,
  faultViolatedMs: 4_000,
  meterLostMax: 0,
  connectionEncryptedPct: 100,
  connectionUnmaskMax: 20,
  droneSuccessMin: 0.95,
  droneSuccessAtRisk: 0.99,
} as const;

/** Drone transfers already finished before the mock started (added to the db's uploads). */
export const DRONE_TRANSFERS = { completed: 18, resumed: 3, failed: 0 } as const;

/** Yesterday's storm: one resolved, acknowledged alert so the alert list has history. */
export function seedAlerts(now: number): Alert[] {
  const raisedAt = now - 26 * 60 * 60 * 1000;
  return [{
    id: '5b0e9c1e-3f7a-4c2d-9a51-7d2c4e8f1a06',
    category: 'fault_records',
    state: 'resolved',
    raisedAt: new Date(raisedAt).toISOString(),
    resolvedAt: new Date(raisedAt + 14 * 60 * 1000).toISOString(),
    causeCode: 'FAULT_P95_ABOVE_TARGET',
    causeFacts: { p95Ms: 3420, targetMs: THRESHOLDS.faultTargetMs, samples: 412, windowMinutes: 1 },
    traceId: null,
    acknowledgedAt: new Date(raisedAt + 3 * 60 * 1000).toISOString(),
    acknowledgedBy: { id: 'u-dispecerat', username: 'dispecerat', displayName: 'Elena Marin', role: 'dispecerat' },
  }];
}

/** Meter simulator: METER_RATE 10/s, STORM_FACTOR 10, DUPLICATE_RATIO 0.02 (docs/api.md "Backend environment"). */
export const NORMAL_RATE_PER_S = 10;
export const STORM_FACTOR = 10;
export const DUPLICATE_RATIO = 0.02;
export const ZONE_SHARE: Record<Zone, number> = { muntenia: 0.45, banat: 0.3, dobrogea: 0.25 };

export type Storm = { category: CategoryId; factor: number; startedAt: number; endsAt: number; periodId: string };

const MONTHS = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sept', 'oct', 'nov', 'dec'];

/** "Furtună · 14 nov 15:33", in Romanian time whatever the browser's zone (the S2 period picker shows it). */
export function stormPeriodLabel(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `Furtună · ${part('day')} ${MONTHS[Number(part('month')) - 1]} ${part('hour')}:${part('minute')}`;
}

/** The scenario's persistent state (db collection `monitoring`, one row), so a reload keeps storms and counters. */
export type MonitoringState = {
  id: 'state';
  storms: Storm[];
  received: number;
  duplicatesRejected: number;
  /** Unique readings stored per zone; their sum is `unique`. */
  byZone: Record<Zone, number>;
  /** Fractions carried to the next tick so counts stay whole. */
  carry: { sent: number; duplicates: number };
  /** Readings the simulator holds while their storage is down: queued, never lost. */
  queueDepth: number;
  simulator: { mode: SimulatorMode; ratePerS: number; stormEndsAt: number | null };
};

/** 1 284 532 received = 1 258 841 unique + 25 691 duplicates rejected; 0 lost. */
export function seedMonitoringState(): MonitoringState {
  return {
    id: 'state',
    storms: [],
    received: 1_284_532,
    duplicatesRejected: 25_691,
    byZone: { muntenia: 566_478, banat: 377_652, dobrogea: 314_711 },
    carry: { sent: 0, duplicates: 0 },
    queueDepth: 0,
    simulator: { mode: 'normal', ratePerS: NORMAL_RATE_PER_S, stormEndsAt: null },
  };
}
