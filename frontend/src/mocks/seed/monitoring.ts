import type { CategoryId } from '@/lib/monitoring/contract';

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
