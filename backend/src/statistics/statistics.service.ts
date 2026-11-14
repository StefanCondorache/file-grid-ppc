import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../common/app-error';
import { CATEGORIES, type Category, STORAGES, type StorageName } from '../common/domain';
import { DB, type Db } from '../database/database';
import { PoliciesService } from '../policies/policies.service';
import { CATEGORY_RATIONALE, STORAGE_LABEL, formatMs, pct } from './interpretations';

const DAY_MS = 86_400_000;
/** Two batches of the same kind further apart than this belong to different periods. */
const PERIOD_GAP_S = 120;

export interface Period {
  readonly id: string;
  readonly label: string;
  readonly kind: 'normal' | 'peak';
  readonly origin: 'simulator' | 'storm' | 'seed' | 'manual';
  readonly start: string;
  readonly end: string | null;
}

interface PerfRow {
  category: Category;
  storage: StorageName;
  samples: string;
  p50: number | null;
  p95: number | null;
  bytes: string | null;
  seconds: number | null;
  errors: string;
}

interface PeriodMetric {
  p95Ms: number | null;
  opsPerS: number | null;
  errorRate: number | null;
  volume: number | null;
}

const round = (value: number | null, digits = 1): number | null =>
  value === null || Number.isNaN(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;

const dateLabel = (date: Date): string =>
  date.toLocaleString('ro-RO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Bucharest',
  });

/**
 * Statistics with plain-language interpretations (TASKS P2.9): a storage benchmark per category,
 * a normal vs peak comparison, and grid insights (consumption peaks, anomalies, faults by zone).
 * Computed from the operations log, the meter batches and the readings.
 */
@Injectable()
export class StatisticsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly policies: PoliciesService,
  ) {}

  /** Peak periods = runs of storm batches; normal periods = runs of regular simulator batches. */
  async periods(): Promise<Period[]> {
    const rows = await sql<{ origin: string; start: Date; end: Date; running: boolean }>`
      WITH ordered AS (
        SELECT at, origin,
               CASE WHEN origin IS DISTINCT FROM lag(origin) OVER w
                      OR at - lag(at) OVER w > make_interval(secs => ${PERIOD_GAP_S})
                    THEN 1 ELSE 0 END AS boundary
        FROM meter_batches
        WHERE at > now() - interval '7 days'
        WINDOW w AS (ORDER BY at)
      ), islands AS (
        SELECT at, origin, sum(boundary) OVER (ORDER BY at) AS island FROM ordered
      )
      SELECT origin, min(at) AS start, max(at) AS end,
             max(at) > now() - make_interval(secs => ${PERIOD_GAP_S}) AS running
      FROM islands GROUP BY island, origin
      HAVING max(at) - min(at) >= interval '30 seconds'
      ORDER BY min(at) DESC LIMIT 20`.execute(this.db);
    return rows.rows.map((row) => {
      const peak = row.origin === 'storm';
      return {
        id: `${row.start.getTime()}-${row.end.getTime()}`,
        label: `${peak ? 'Furtună' : 'Zi normală'} ${dateLabel(row.start)}`,
        kind: peak ? 'peak' : 'normal',
        origin: row.origin as Period['origin'],
        start: row.start.toISOString(),
        end: row.running && peak ? null : row.end.toISOString(),
      };
    });
  }

  async storageFit() {
    const perf = await this.performance(new Date(Date.now() - 7 * DAY_MS), new Date());
    const policies = await this.policies.list();
    const items = CATEGORIES.map((category) => {
      const storages = STORAGES.map((storage) => {
        const row = perf.find((p) => p.category === category && p.storage === storage);
        const samples = Number(row?.samples ?? 0);
        return {
          storage,
          samples,
          p50Ms: round(row?.p50 ?? null),
          p95Ms: round(row?.p95 ?? null),
          throughputBps:
            row?.bytes && row.seconds
              ? Math.round(Number(row.bytes) / Math.max(row.seconds, 0.001))
              : null,
          errorRate: samples > 0 ? round(Number(row?.errors ?? 0) / samples, 3) : null,
        };
      });
      const rationale = CATEGORY_RATIONALE[category];
      const policy = policies.find((p) => p.category === category);
      const measured = storages.filter((s) => s.samples >= 5 && s.p95Ms !== null);
      const fastest = [...measured].sort((a, b) => (a.p95Ms ?? 0) - (b.p95Ms ?? 0))[0];
      const current = storages.find((s) => s.storage === policy?.primaryStorage);
      const text =
        `${STORAGE_LABEL[rationale.storage]} se potrivește pentru această categorie. ${rationale.why}` +
        (current && current.samples > 0
          ? ` Măsurat pe ${STORAGE_LABEL[current.storage]}: p95 ${formatMs(current.p95Ms)}, ${current.samples} operații, erori ${pct(current.errorRate)}.`
          : ' Încă nu sunt destule măsurători pentru această categorie.');
      const recommendation =
        policy && policy.primaryStorage !== rationale.storage
          ? `Politica folosește acum ${STORAGE_LABEL[policy.primaryStorage]}; recomandăm ${STORAGE_LABEL[rationale.storage]}.`
          : fastest && fastest.storage !== rationale.storage
            ? `În măsurători ${STORAGE_LABEL[fastest.storage]} a fost mai rapid (p95 ${formatMs(fastest.p95Ms)}); verificați dacă diferența se menține.`
            : null;
      return {
        category,
        storages,
        recommendedStorage: rationale.storage,
        interpretation: {
          text,
          recommendation,
          facts: {
            primaryStorage: policy?.primaryStorage ?? null,
            fastest: fastest?.storage ?? null,
          },
        },
      };
    });
    return { periodId: null, items };
  }

  async compare(periodA: string, periodB: string) {
    const periods = await this.periods();
    const a = periods.find((p) => p.id === periodA);
    const b = periods.find((p) => p.id === periodB);
    if (!a || !b) throw new AppError(404, 'NOT_FOUND', 'Perioada nu există.');
    const [ra, rb] = await Promise.all([this.periodMetrics(a), this.periodMetrics(b)]);
    const rows = CATEGORIES.flatMap((category) =>
      (['p95Ms', 'opsPerS', 'errorRate', 'volume'] as const).map((metric) => {
        const va = ra.get(category)?.[metric] ?? null;
        const vb = rb.get(category)?.[metric] ?? null;
        const deltaPct =
          va !== null && vb !== null && va !== 0 ? round(((vb - va) / va) * 100) : null;
        return { category, metric, a: va, b: vb, deltaPct };
      }),
    );
    const meterA = ra.get('meter_readings')?.opsPerS ?? null;
    const meterB = rb.get('meter_readings')?.opsPerS ?? null;
    const factor = meterA && meterB ? round(meterB / meterA) : null;
    const stable = CATEGORIES.filter((c) => c !== 'meter_readings').every((c) => {
      const before = ra.get(c)?.p95Ms ?? null;
      const after = rb.get(c)?.p95Ms ?? null;
      return before === null || after === null || after <= before * 1.5 + 50;
    });
    const text =
      `Citirile de contor s-au schimbat de ${factor ?? '?'} ori (${meterA ?? 0} → ${meterB ?? 0} citiri/s). ` +
      (stable
        ? 'Celelalte categorii și-au păstrat timpii de răspuns: compartimentele (bulkhead) le-au izolat de vârf.'
        : 'Unele categorii au încetinit în vârf: verificați limitele de concurență din politici.');
    return {
      periodA: a,
      periodB: b,
      rows,
      interpretation: {
        text,
        recommendation: stable
          ? null
          : 'Măriți maxConcurrency pentru categoriile afectate sau scalați backend-ul.',
        facts: { factor, isolated: stable },
      },
    };
  }

  async gridInsights() {
    const since = new Date(Date.now() - DAY_MS);
    const faults = await this.db
      .selectFrom('files')
      .select(['zone', (eb) => eb.fn.countAll<string>().as('count')])
      .where('category', '=', 'fault_records')
      .where('zone', 'is not', null)
      .groupBy('zone')
      .execute();
    const consumption = await sql<{ zone: string; hour: number; avg_kwh: number }>`
      SELECT zone, extract(hour FROM reading_time AT TIME ZONE 'Europe/Bucharest')::int AS hour,
             avg(kwh)::float8 AS avg_kwh
      FROM meter_readings WHERE reading_time > ${since}
      GROUP BY zone, hour ORDER BY zone, hour`.execute(this.db);
    const anomalies = await sql<{
      meter_id: string;
      zone: string;
      kwh: number;
      reading_time: Date;
      file_id: string;
      type: string;
    }>`
      WITH baseline AS (
        SELECT zone, avg(kwh) AS avg_kwh FROM meter_readings WHERE reading_time > ${since} GROUP BY zone
      )
      SELECT r.meter_id, r.zone, r.kwh::float8 AS kwh, r.reading_time, r.file_id,
             CASE WHEN r.kwh = 0 THEN 'zero' ELSE 'spike' END AS type
      FROM meter_readings r JOIN baseline b USING (zone)
      WHERE r.reading_time > ${since} AND (r.kwh = 0 OR r.kwh > 5 * b.avg_kwh)
      ORDER BY r.reading_time DESC LIMIT 50`.execute(this.db);
    const byZone = faults.map((f) => ({ zone: f.zone, county: null, count: Number(f.count) }));
    const top = [...byZone].sort((x, y) => y.count - x.count)[0];
    const peak = [...consumption.rows].sort((x, y) => y.avg_kwh - x.avg_kwh)[0];
    const text = [
      top
        ? `Cele mai multe avarii raportate: ${top.zone} (${top.count}).`
        : 'Nu sunt avarii raportate.',
      peak
        ? `Vârful de consum: ${peak.zone}, ora ${peak.hour}:00 (${peak.avg_kwh.toFixed(2).replace('.', ',')} kWh în medie pe citire).`
        : '',
      `${anomalies.rows.length} citiri anormale în ultimele 24 h (zero sau peste 5x media zonei).`,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      faultsByZone: byZone,
      consumptionByHourZone: consumption.rows.map((row) => ({
        zone: row.zone,
        hour: row.hour,
        avgKwh: round(row.avg_kwh, 3),
      })),
      anomalies: anomalies.rows.map((row) => ({
        meterId: row.meter_id,
        zone: row.zone,
        type: row.type,
        detectedAt: row.reading_time.toISOString(),
        value: row.kwh,
        fileId: row.file_id,
      })),
      interpretation: {
        text,
        recommendation:
          anomalies.rows.length > 0
            ? 'Verificați contoarele cu citiri anormale; pot indica fraude sau defecte.'
            : null,
        facts: {
          topFaultZone: top?.zone ?? null,
          peakHour: peak?.hour ?? null,
          anomalies: anomalies.rows.length,
        },
      },
    };
  }

  private async performance(from: Date, to: Date): Promise<PerfRow[]> {
    const result = await sql<PerfRow>`
      SELECT category, storage, count(*) AS samples,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
             sum(size_bytes) FILTER (WHERE operation IN ('upload.complete', 'file.download')) AS bytes,
             sum(duration_ms) FILTER (WHERE operation IN ('upload.complete', 'file.download')) / 1000.0 AS seconds,
             count(*) FILTER (WHERE status = 'error') AS errors
      FROM operations
      WHERE started_at BETWEEN ${from} AND ${to} AND category IS NOT NULL AND storage IS NOT NULL
      GROUP BY category, storage`.execute(this.db);
    return result.rows;
  }

  private async periodMetrics(period: Period): Promise<Map<Category, PeriodMetric>> {
    const from = new Date(period.start);
    const to = period.end ? new Date(period.end) : new Date();
    const seconds = Math.max(1, (to.getTime() - from.getTime()) / 1000);
    const ops = await sql<{
      category: Category;
      n: string;
      p95: number | null;
      errors: string;
      volume: string | null;
    }>`
      SELECT category, count(*) AS n,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
             count(*) FILTER (WHERE status = 'error') AS errors,
             sum(size_bytes) AS volume
      FROM operations WHERE started_at BETWEEN ${from} AND ${to} AND category IS NOT NULL
      GROUP BY category`.execute(this.db);
    const meter = await this.db
      .selectFrom('meter_batches')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('received'), eb.lit(0)).as('received'))
      .where('at', '>=', from)
      .where('at', '<=', to)
      .executeTakeFirstOrThrow();
    const metrics = new Map<Category, PeriodMetric>();
    for (const row of ops.rows) {
      const n = Number(row.n);
      metrics.set(row.category, {
        p95Ms: round(row.p95),
        opsPerS: round(n / seconds, 2),
        errorRate: n > 0 ? round(Number(row.errors) / n, 3) : null,
        volume: row.volume === null ? null : Number(row.volume),
      });
    }
    const readings = Number(meter.received);
    metrics.set('meter_readings', {
      p95Ms: metrics.get('meter_readings')?.p95Ms ?? null,
      errorRate: metrics.get('meter_readings')?.errorRate ?? null,
      opsPerS: round(readings / seconds, 1),
      volume: readings,
    });
    return metrics;
  }
}
