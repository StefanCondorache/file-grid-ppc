/**
 * Wire types of the statistics endpoint group as the NestJS backend implements it (docs/api.md "Statistics";
 * backend/src/statistics). Hand-written because the generated schema.d.ts still follows the OpenAPI proposal, whose
 * category and storage ids differ ("Differences from the frontend proposal"). Shapes, not behaviour.
 *
 * Real-contract notes for the screens: `GET /statistics/period-comparison` takes `a` and `b` (not `periodA` /
 * `periodB`) and the real backend requires both, so the UI picks the default pair itself (last normal vs most recent
 * peak). `excludeGenerated` and `periodId` exist only in the proposal: the mock honours `excludeGenerated`, the real
 * backend ignores both and answers `periodId: null`.
 */
import type { Zone } from '@/lib/api/types';
import type { StorageId } from '@/lib/upload/types';

export type { StorageId, Zone };

/** Category ids of the real backend, in its order (backend/src/common/domain.ts). */
export const STATS_CATEGORIES = ['meter_readings', 'fault_records', 'connection_documents', 'drone_videos'] as const;
export type StatsCategoryId = (typeof STATS_CATEGORIES)[number];

export const STORAGE_IDS = ['s3', 'ftp', 'db'] as const satisfies readonly StorageId[];
export const ZONES = ['muntenia', 'banat', 'dobrogea'] as const satisfies readonly Zone[];

export type Origin = 'manual' | 'simulator' | 'storm' | 'seed';

/** OQ-7: Romanian `text` and `recommendation` from the backend, or null and the UI templates them from `facts`. */
export type Interpretation<F = Record<string, unknown>> = {
  text: string | null;
  recommendation: string | null;
  facts: F;
};

/** A run of storm batches (`peak`) or of regular simulator batches (`normal`). */
export type Period = {
  id: string;
  label: string;
  kind: 'normal' | 'peak';
  origin: Origin;
  start: string;
  /** null while a storm is running. */
  end: string | null;
};

export type PeriodList = {
  data: Period[];
};

export type StoragePerformance = {
  storage: StorageId;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  throughputBps: number | null;
  errorRate: number | null;
};

/** The real backend sends `primaryStorage` and `fastest`; the mock adds the runner-up and how many times faster. */
export type StorageFitFacts = {
  primaryStorage: StorageId | null;
  fastest: StorageId | null;
  runnerUp?: StorageId | null;
  /** p95 of the runner-up ÷ p95 of the fastest, 1 decimal (3 = "de 3× mai repede"). */
  speedup?: number | null;
};

export type StorageFitItem = {
  category: StatsCategoryId;
  storages: StoragePerformance[];
  recommendedStorage: StorageId;
  interpretation: Interpretation<StorageFitFacts & Record<string, unknown>>;
};

/** S1, `GET /statistics/storage-fit`. */
export type StorageFit = {
  periodId: string | null;
  items: StorageFitItem[];
};

/** The S2 metrics, in the backend's row order. */
export const COMPARISON_METRICS = ['p95Ms', 'opsPerS', 'errorRate', 'volume'] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

export type ComparisonRow = {
  category: StatsCategoryId;
  metric: ComparisonMetric;
  a: number | null;
  b: number | null;
  /** (b − a) ÷ a × 100, 1 decimal; null when a is 0 or a value is missing. */
  deltaPct: number | null;
};

/** The real backend sends `factor` and `isolated`; the mock adds which category the peak hit and by how much. */
export type ComparisonFacts = {
  /** Load factor of the stormed category (ops/s in B ÷ ops/s in A). */
  factor: number | null;
  /** Every other category kept its p95 (≤ 1,5 × A + 50 ms): the bulkheads isolated the peak. */
  isolated: boolean;
  mostAffected?: StatsCategoryId | null;
  mostAffectedDeltaPct?: number | null;
};

/** S2, `GET /statistics/period-comparison?a=&b=`. */
export type PeriodComparison = {
  periodA: Period;
  periodB: Period;
  rows: ComparisonRow[];
  interpretation: Interpretation<ComparisonFacts & Record<string, unknown>>;
};

/** The real backend sends `zero` and `spike`; the mock also `negative` and `silent`. */
export const ANOMALY_TYPES = ['zero', 'negative', 'spike', 'silent'] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export type ZoneFaults = {
  zone: Zone;
  /** Always null: the map granularity is the 3 regions (OQ-6). */
  county: string | null;
  count: number;
};

export type HourlyConsumption = {
  zone: Zone;
  /** 0–23, Europe/Bucharest. */
  hour: number;
  avgKwh: number;
};

export type MeterAnomaly = {
  meterId: string;
  zone: Zone;
  type: AnomalyType;
  detectedAt: string;
  value: number | null;
  fileId: string | null;
};

export type GridFacts = {
  topFaultZone: Zone | null;
  peakHour: number | null;
  anomalies: number;
  peakZone?: Zone | null;
  faultsTotal?: number;
};

/** S3, `GET /statistics/grid-insights` (last 24 h). */
export type GridInsights = {
  faultsByZone: ZoneFaults[];
  consumptionByHourZone: HourlyConsumption[];
  anomalies: MeterAnomaly[];
  interpretation: Interpretation<GridFacts & Record<string, unknown>>;
};
