/**
 * Wire types of the monitoring group and its live events as the NestJS backend implements them (docs/api.md
 * "Monitoring and traces"; backend/src/guarantees, monitoring, meters, demo). Hand-written because the generated
 * schema.d.ts still follows the OpenAPI proposal, whose category and storage ids differ ("Differences from the
 * frontend proposal"). Shapes, not behaviour.
 */
import type { Role } from '@/lib/api/types';
import type { Zone } from '@/lib/upload/contract';
import type { StorageId } from '@/lib/upload/types';

export type { StorageId, Zone };

/** Category ids of the real backend (docs/api.md "Basics"), in board order. */
export const CATEGORY_IDS = ['meter_readings', 'fault_records', 'connection_documents', 'drone_videos'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Storage ids of the real backend; displayed as S3, FTP, PostgreSQL. */
export const STORAGE_IDS = ['s3', 'ftp', 'db'] as const satisfies readonly StorageId[];

export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const satisfies readonly Zone[];

export type GuaranteeState = 'ok' | 'at_risk' | 'violated';
export type Comparator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

export interface GuaranteeMetric {
  key: string;
  /** Decimal string (timestamps ISO); null when there is no sample yet. */
  value: string | null;
  unit: string | null;
  threshold: string | null;
  comparator: Comparator | null;
}

/** GET /guarantees `{ data }` and the `guarantees.status` event `{ items }`. */
export interface GuaranteeStatus {
  category: CategoryId;
  state: GuaranteeState;
  /** e.g. FAULT_P95_ABOVE_TARGET; null when `ok`. */
  causeCode: string | null;
  /** The values behind causeCode, for the UI's Romanian sentence (fault: p95Ms, targetMs, samples, windowMinutes). */
  causeFacts: Record<string, unknown>;
  metrics: GuaranteeMetric[];
  updatedAt: string;
}

/** GET /alerts (paged), POST /alerts/{id}/acknowledge, and the `alert.raised` / `alert.updated` events. */
export interface Alert {
  id: string;
  category: CategoryId;
  state: 'at_risk' | 'violated' | 'resolved';
  raisedAt: string;
  resolvedAt: string | null;
  causeCode: string;
  causeFacts: Record<string, unknown>;
  traceId: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; username: string; displayName: string; role: Role | null } | null;
}

export type StorageStatus = 'ok' | 'degraded' | 'down';
export type CircuitState = 'closed' | 'half_open' | 'open';

/** GET /storage-health `{ data }` and the `storage.health` event `{ items }`. */
export interface StorageHealth {
  storage: StorageId;
  status: StorageStatus;
  latencyMs: number | null;
  lastCheckAt: string;
  circuitState: CircuitState;
}

/** GET /meters/counters and the `meters.counters` event. `lost` is null when the simulator is unreachable. */
export interface MeterCounters {
  received: number;
  unique: number;
  duplicatesRejected: number;
  lost: number | null;
  ratePerS: number;
  byZone: { zone: Zone; received: number; ratePerS: number }[];
  at: string;
}

export type SimulatorMode = 'normal' | 'peak' | 'custom' | 'stopped';

/** GET /meters/simulator and the `simulator.status` event. */
export interface SimulatorStatus {
  mode: SimulatorMode;
  ratePerS: number;
  normalRatePerS: number;
  peakRatePerS: number;
  queueDepth: number;
  stormEndsAt: string | null;
  sentUnique: number;
  ackedUnique: number;
}

export type MatrixWindow = '5m' | '1h' | '24h';

export interface MetricsCell {
  category: CategoryId;
  storage: StorageId;
  requests: number;
  noTraffic: boolean;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  throughputBps: number | null;
  opsPerS: number | null;
  errorRate: number | null;
}

/** GET /metrics/matrix?window= (one cell per category × storage). */
export interface MetricsMatrix {
  window: MatrixWindow;
  generatedAt: string;
  cells: MetricsCell[];
}

export type SeriesWindow = '5m' | '15m' | '1h';

