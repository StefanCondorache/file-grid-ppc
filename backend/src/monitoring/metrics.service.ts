import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CATEGORIES, type Category, STORAGES, type StorageName } from '../common/domain';
import { DB, type Db } from '../database/database';

export const MATRIX_WINDOWS = { '5m': 300, '1h': 3600, '24h': 86_400 } as const;
export type MatrixWindow = keyof typeof MATRIX_WINDOWS;

/** Window -> step; always 30 points per series. */
export const SERIES_WINDOWS = { '5m': 10, '15m': 30, '1h': 120 } as const;
export type SeriesWindow = keyof typeof SERIES_WINDOWS;
const SERIES_POINTS = 30;

interface CellRow {
  category: Category;
  storage: StorageName;
  requests: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errors: string;
  bytes: string | null;
  seconds: number | null;
}

interface PointRow {
  category: Category;
  bucket: number;
  p95: number | null;
  n: string;
}

const round = (value: number | null, digits = 2): number | null =>
  value === null ? null : Number(Number(value).toFixed(digits));

/** Latency, throughput and error rate per category and storage, from the operations log. */
@Injectable()
export class MetricsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** GET /metrics/matrix: one cell per category x storage over the window (BA-43). */
  async matrix(window: MatrixWindow) {
    const seconds = MATRIX_WINDOWS[window];
    const since = new Date(Date.now() - seconds * 1000);
    const { rows } = await sql<CellRow>`
      SELECT category, storage, count(*) AS requests,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
             count(*) FILTER (WHERE status = 'error') AS errors,
             sum(size_bytes) FILTER (WHERE status = 'ok' AND operation IN ('upload.complete', 'file.download')) AS bytes,
             sum(duration_ms) FILTER (WHERE status = 'ok' AND operation IN ('upload.complete', 'file.download')) / 1000.0 AS seconds
      FROM operations
      WHERE started_at >= ${since} AND category IS NOT NULL AND storage IS NOT NULL
      GROUP BY category, storage`.execute(this.db);
    const cells = CATEGORIES.flatMap((category) =>
      STORAGES.map((storage) => {
        const row = rows.find((r) => r.category === category && r.storage === storage);
        const requests = Number(row?.requests ?? 0);
        const traffic = requests > 0;
        const bytes = Number(row?.bytes ?? 0);
        return {
          category,
          storage,
          requests,
          noTraffic: !traffic,
          p50Ms: round(row?.p50 ?? null),
          p95Ms: round(row?.p95 ?? null),
          p99Ms: round(row?.p99 ?? null),
          throughputBps:
            bytes > 0 && row?.seconds ? Math.round(bytes / Math.max(row.seconds, 0.001)) : null,
          opsPerS: traffic ? requests / seconds : null,
          errorRate: traffic ? Number(row?.errors ?? 0) / requests : null,
        };
      }),
    );
    return { window, generatedAt: new Date().toISOString(), cells };
  }

  /** The BulkheadSeries of GET /metrics/bulkhead: p95 and ops/s per category on one time axis (BA-44). */
  async bulkheadSeries(window: SeriesWindow) {
    const stepS = SERIES_WINDOWS[window];
    const lastBucket = Math.floor(Date.now() / 1000 / stepS) * stepS;
    const firstBucket = lastBucket - (SERIES_POINTS - 1) * stepS;
    const { rows } = await sql<PointRow>`
      SELECT category,
             (floor(extract(epoch FROM started_at) / ${stepS}) * ${stepS})::bigint AS bucket,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
             count(*) AS n
      FROM operations
      WHERE started_at >= to_timestamp(${firstBucket}) AND category IS NOT NULL
      GROUP BY 1, 2`.execute(this.db);
    const byKey = new Map(rows.map((row) => [`${row.category}:${Number(row.bucket)}`, row]));
    const series = CATEGORIES.map((category) => ({
      category,
      points: Array.from({ length: SERIES_POINTS }, (_, index) => {
        const bucket = firstBucket + index * stepS;
        const row = byKey.get(`${category}:${bucket}`);
        return {
          t: new Date(bucket * 1000).toISOString(),
          p95Ms: round(row?.p95 ?? null),
          opsPerS: row ? Number(row.n) / stepS : 0,
        };
      }),
    }));
    return { window, stepS, series };
  }
}
