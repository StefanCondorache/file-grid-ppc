import type { Alert, CategoryId } from '@/lib/monitoring/contract';

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
  /** Operations per second at normal load (meters: batches of the simulator). */
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
