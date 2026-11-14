import {
  ZONES,
  type ComparisonMetric,
  type HourlyConsumption,
  type MeterAnomaly,
  type Period,
  type StatsCategoryId,
  type StorageId,
  type Zone,
} from '@/features/statistics/contract';
import type { MockDb } from '../db';

/**
 * Statistics seed (Task 6f.1): the labelled periods and the numbers behind S1, S2 and S3, in the real backend's ids.
 * The handlers derive every answer and its `facts` from these, so the screens' interpretations follow the data.
 */

/** The seed run's normal day and the storm run before the demo (FE-12). Bucharest is UTC+2 in November. */
export const SEED_PERIODS: readonly Period[] = [
  { id: 'p-2026-11-12-normal', label: 'Zi normală · 12 nov', kind: 'normal', origin: 'seed', start: '2026-11-11T22:00:00.000Z', end: '2026-11-12T21:59:59.000Z' },
  { id: 'p-2026-11-14-storm', label: 'Furtună · 14 nov 15:33', kind: 'peak', origin: 'storm', start: '2026-11-14T13:33:00.000Z', end: '2026-11-14T13:48:00.000Z' },
];

/** Seeds `periods` into a db. The base db creates the collection empty, which `register` keeps, so fill it once. */
export function seedStatistics(target: MockDb): void {
  const rows = () => SEED_PERIODS.map((p) => ({ ...p }));
  target.register('periods', rows);
  if (target.list('periods').length === 0) rows().forEach((p) => target.insert('periods', p));
}

/** One cell of the 7-day operations log; `generated` of its `samples` came from the simulator, storms or the seed. */
export type PerfSeed = { samples: number; generated: number; p50Ms: number; p95Ms: number; throughputBps: number; errorRate: number };

/** S1: measured per category × storage. Storages that never served a category are absent (0 samples). */
export const STORAGE_FIT_SEED: Readonly<Record<StatsCategoryId, { recommended: StorageId; perf: Partial<Record<StorageId, PerfSeed>> }>> = {
  meter_readings: {
    recommended: 'db',
    perf: { db: { samples: 60_480, generated: 60_480, p50Ms: 14, p95Ms: 42, throughputBps: 1_850_000, errorRate: 0 } },
  },
  fault_records: {
    recommended: 's3',
    perf: {
      s3: { samples: 1_240, generated: 1_080, p50Ms: 240, p95Ms: 600, throughputBps: 8_738_133, errorRate: 0.002 },
      ftp: { samples: 96, generated: 80, p50Ms: 760, p95Ms: 1_800, throughputBps: 2_912_711, errorRate: 0.01 },
    },
  },
  connection_documents: {
    recommended: 'db',
    perf: {
      db: { samples: 412, generated: 352, p50Ms: 110, p95Ms: 250, throughputBps: 6_400_000, errorRate: 0 },
      s3: { samples: 18, generated: 12, p50Ms: 190, p95Ms: 420, throughputBps: 4_100_000, errorRate: 0 },
    },
  },
  drone_videos: {
    recommended: 's3',
    perf: {
      s3: { samples: 64, generated: 48, p50Ms: 820, p95Ms: 1_400, throughputBps: 48_000_000, errorRate: 0 },
      ftp: { samples: 22, generated: 16, p50Ms: 1_300, p95Ms: 2_100, throughputBps: 31_000_000, errorRate: 0.045 },
    },
  },
};

const MiB = 1024 * 1024;
type PeriodMetrics = Readonly<Record<ComparisonMetric, number | null>>;

/**
 * S2 by period kind, so a peak period a storm adds to `db.periods` (Task 6e) compares at once. The storm hits the
 * faults: their load ×10 and p95 0,6 s → 3,4 s, while the bulkheads keep the other categories flat. `volume` is
 * readings for meters and bytes for files, over the period (a day vs 15 minutes).
 */
export const PERIOD_METRICS: Readonly<Record<Period['kind'], Readonly<Record<StatsCategoryId, PeriodMetrics>>>> = {
  normal: {
    meter_readings: { p95Ms: 42, opsPerS: 50, errorRate: 0, volume: 4_320_000 },
    fault_records: { p95Ms: 600, opsPerS: 0.01, errorRate: 0.002, volume: 864 * 5 * MiB },
    connection_documents: { p95Ms: 250, opsPerS: 0.002, errorRate: 0, volume: 173 * 2 * MiB },
    drone_videos: { p95Ms: 1_400, opsPerS: 0.0005, errorRate: 0, volume: 43 * 400 * MiB },
  },
  peak: {
    meter_readings: { p95Ms: 45, opsPerS: 52, errorRate: 0, volume: 46_800 },
    fault_records: { p95Ms: 3_400, opsPerS: 0.1, errorRate: 0.011, volume: 90 * 5 * MiB },
    connection_documents: { p95Ms: 265, opsPerS: 0.002, errorRate: 0, volume: 2 * 2 * MiB },
    drone_videos: { p95Ms: 1_480, opsPerS: 0.0005, errorRate: 0, volume: 1 * 400 * MiB },
  },
};

/** S3: faults reported in the last 24 h per region; `generated` of them came from storms or the seed. */
export const FAULTS_BY_ZONE: readonly { zone: Zone; count: number; generated: number }[] = [
  { zone: 'muntenia', count: 38, generated: 29 },
  { zone: 'banat', count: 14, generated: 9 },
  { zone: 'dobrogea', count: 23, generated: 17 },
];

/** Share of the daily mean per hour (Europe/Bucharest): low at night, a morning rise and the 19:00 evening peak. */
const HOURLY_PROFILE = [0.55, 0.5, 0.47, 0.45, 0.46, 0.52, 0.68, 0.85, 0.92, 0.88, 0.84, 0.83, 0.86, 0.84, 0.8, 0.79, 0.84, 0.97, 1.12, 1.2, 1.15, 1, 0.82, 0.66];
/** kWh per 15-minute reading at the daily mean. */
const ZONE_MEAN_KWH: Readonly<Record<Zone, number>> = { muntenia: 0.42, banat: 0.36, dobrogea: 0.39 };

/** S3: mean kWh per reading by zone and hour (meter readings come only from the simulator). */
export const HOURLY_CONSUMPTION: readonly HourlyConsumption[] = ZONES.flatMap((zone) =>
  HOURLY_PROFILE.map((share, hour) => ({ zone, hour, avgKwh: Math.round(ZONE_MEAN_KWH[zone] * share * 1000) / 1000 })),
);

/** S3: readings of zero, negative or above 5× the zone mean, and meters that went silent. */
export const METER_ANOMALIES: readonly MeterAnomaly[] = [
  { meterId: 'RO-MUN-000412', zone: 'muntenia', type: 'spike', detectedAt: '2026-11-14T17:45:00.000Z', value: 3.86, fileId: null },
  { meterId: 'RO-DOB-000087', zone: 'dobrogea', type: 'zero', detectedAt: '2026-11-14T16:30:00.000Z', value: 0, fileId: null },
  { meterId: 'RO-BAN-000215', zone: 'banat', type: 'negative', detectedAt: '2026-11-14T14:15:00.000Z', value: -0.42, fileId: null },
  { meterId: 'RO-MUN-001203', zone: 'muntenia', type: 'silent', detectedAt: '2026-11-14T11:00:00.000Z', value: null, fileId: null },
  { meterId: 'RO-DOB-000311', zone: 'dobrogea', type: 'spike', detectedAt: '2026-11-14T09:30:00.000Z', value: 2.95, fileId: null },
  { meterId: 'RO-MUN-000058', zone: 'muntenia', type: 'zero', detectedAt: '2026-11-14T06:15:00.000Z', value: 0, fileId: null },
];
