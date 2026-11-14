import { http, HttpResponse } from 'msw';
import {
  STATS_CATEGORIES,
  STORAGE_IDS,
  type ComparisonMetric,
  type ComparisonRow,
  type GridInsights,
  type Period,
  type PeriodComparison,
  type StatsCategoryId,
  type StorageFit,
  type StorageFitItem,
  type StorageId,
  type StoragePerformance,
} from '@/features/statistics/contract';
import { apiUrl } from '@/lib/api/base';
import type { Category } from '@/lib/api/types';
import { db } from '../db';
import { CAPABILITIES } from '../seed/auth';
import { FAULTS_BY_ZONE, HOURLY_CONSUMPTION, METER_ANOMALIES, PERIOD_METRICS, seedStatistics, STORAGE_FIT_SEED } from '../seed/statistics';
import { currentSession, touchSession } from '../session';

/**
 * The statistics group (docs/api.md "Statistics") in MSW, in the real backend's ids and query names (`a`, `b`).
 * Periods live in the shared `db.periods`, so a storm that records a peak period (Task 6e) is offered here at once.
 * OQ-7: every interpretation carries `facts` with `text` and `recommendation` null, so on mocks the screens show their
 * own templates (Task 6f.2); the real backend sends Romanian text, which wins. Proposal-only `excludeGenerated` drops
 * storm, simulator and seed data; `periodId` is ignored, as the real backend does.
 */
seedStatistics(db);

const LEGACY_CATEGORY: Readonly<Record<StatsCategoryId, Category>> = {
  meter_readings: 'meter', fault_records: 'fault', connection_documents: 'connection', drone_videos: 'drone',
};
const METRICS: readonly ComparisonMetric[] = ['p95Ms', 'opsPerS', 'errorRate', 'volume'];
/** Like the backend: fewer measurements than this never make a storage "the fastest". */
const MIN_SAMPLES = 5;

const trace = () => `mock-${Math.random().toString(16).slice(2, 10)}`;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const flag = (value: string | null) => value === 'true' || value === '1';

function reply(body: unknown): Response {
  return HttpResponse.json(body as never, { headers: { 'X-Trace-Id': trace() } });
}

function fail(status: number, code: string, message: string): Response {
  const traceId = trace();
  return HttpResponse.json({ code, message, traceId }, { status, headers: { 'X-Trace-Id': traceId } });
}

/** 401 without a session, 403 when the active role lacks `view_statistics` (the backend's guard order). */
function denied(): Response | null {
  const session = currentSession();
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sesiunea a expirat.');
  if (!CAPABILITIES[session.activeRole].includes('view_statistics')) return fail(403, 'FORBIDDEN', 'Rolul activ nu are dreptul la această acțiune.');
  touchSession();
  return null;
}

const startMs = (p: Period) => Date.parse(p.start);

/** `db.periods`, newest first. */
export function listPeriods(): Period[] {
  return [...db.list<Period>('periods')].sort((x, y) => startMs(y) - startMs(x));
}

/** The S2 default (FE-12): the last normal period vs the most recent peak; null when either kind is missing. */
export function defaultComparison(periods: readonly Period[]): { a: Period; b: Period } | null {
  const newest = (kind: Period['kind']) =>
    periods.filter((p) => p.kind === kind).reduce<Period | null>((best, p) => (!best || startMs(p) > startMs(best) ? p : best), null);
  const a = newest('normal');
  const b = newest('peak');
  return a && b ? { a, b } : null;
}

function performance(category: StatsCategoryId, storage: StorageId, excludeGenerated: boolean): StoragePerformance {
  const seed = STORAGE_FIT_SEED[category].perf[storage];
  const samples = seed ? seed.samples - (excludeGenerated ? seed.generated : 0) : 0;
  if (!seed || samples <= 0) return { storage, samples: 0, p50Ms: null, p95Ms: null, throughputBps: null, errorRate: null };
  return { storage, samples, p50Ms: seed.p50Ms, p95Ms: seed.p95Ms, throughputBps: seed.throughputBps, errorRate: seed.errorRate };
}

/** The live policy's primary storage (seeded with the proposal's ids; accepts the real ones too). */
function primaryStorage(category: StatsCategoryId): StorageId | null {
  const policy = db.policies.get(LEGACY_CATEGORY[category]) ?? db.find<{ category: string; primaryStorage: string }>('policies', (p) => p.category === category);
  const storage = String(policy?.primaryStorage ?? '').toLowerCase();
  return (STORAGE_IDS as readonly string[]).includes(storage) ? (storage as StorageId) : null;
}

function storageFit(excludeGenerated: boolean): StorageFit {
  const items = STATS_CATEGORIES.map((category): StorageFitItem => {
    const storages = STORAGE_IDS.map((storage) => performance(category, storage, excludeGenerated));
    const [fastest, runnerUp] = storages
      .filter((s): s is StoragePerformance & { p95Ms: number } => s.samples >= MIN_SAMPLES && s.p95Ms !== null)
      .sort((x, y) => x.p95Ms - y.p95Ms);
    return {
      category,
      storages,
      recommendedStorage: STORAGE_FIT_SEED[category].recommended,
      interpretation: {
        text: null,
        recommendation: null,
        facts: {
          primaryStorage: primaryStorage(category),
          fastest: fastest?.storage ?? null,
          runnerUp: runnerUp?.storage ?? null,
          speedup: fastest && runnerUp ? round(runnerUp.p95Ms / fastest.p95Ms) : null,
        },
      },
    };
  });
  return { periodId: null, items };
}

function compare(a: Period, b: Period): PeriodComparison {
  const rows = STATS_CATEGORIES.flatMap((category) =>
    METRICS.map((metric): ComparisonRow => {
      const va = PERIOD_METRICS[a.kind][category][metric];
      const vb = PERIOD_METRICS[b.kind][category][metric];
      const deltaPct = va !== null && vb !== null && va !== 0 ? round(((vb - va) / va) * 100) : null;
      return { category, metric, a: va, b: vb, deltaPct };
    }),
  );
  const row = (category: StatsCategoryId, metric: ComparisonMetric) => rows.find((r) => r.category === category && r.metric === metric)!;
  const slower = STATS_CATEGORIES.filter((c) => (row(c, 'p95Ms').deltaPct ?? 0) > 0);
  const mostAffected = [...slower].sort((x, y) => row(y, 'p95Ms').deltaPct! - row(x, 'p95Ms').deltaPct!)[0] ?? null;
  const ops = mostAffected ? row(mostAffected, 'opsPerS') : null;
  // The backend's rule: a category kept its response time when p95 B ≤ 1,5 × A + 50 ms.
  const isolated = STATS_CATEGORIES.filter((c) => c !== mostAffected).every((c) => {
    const { a: before, b: after } = row(c, 'p95Ms');
    return before === null || after === null || after <= before * 1.5 + 50;
  });
  return {
    periodA: a,
    periodB: b,
    rows,
    interpretation: {
      text: null,
      recommendation: null,
      facts: {
        factor: ops?.a && ops.b !== null ? round(ops.b / ops.a) : null,
        isolated,
        mostAffected,
        mostAffectedDeltaPct: mostAffected ? row(mostAffected, 'p95Ms').deltaPct : null,
      },
    },
  };
}

function gridInsights(excludeGenerated: boolean): GridInsights {
  const faultsByZone = FAULTS_BY_ZONE.map(({ zone, count, generated }) => ({ zone, county: null, count: excludeGenerated ? count - generated : count }));
  // Meter readings come only from the simulator: without generated data there is no consumption and no anomaly.
  const consumptionByHourZone = excludeGenerated ? [] : HOURLY_CONSUMPTION.map((c) => ({ ...c }));
  const anomalies = excludeGenerated ? [] : [...METER_ANOMALIES].sort((x, y) => Date.parse(y.detectedAt) - Date.parse(x.detectedAt));
  const top = faultsByZone.filter((z) => z.count > 0).sort((x, y) => y.count - x.count)[0];
  const peak = [...consumptionByHourZone].sort((x, y) => y.avgKwh - x.avgKwh)[0];
  return {
    faultsByZone,
    consumptionByHourZone,
    anomalies,
    interpretation: {
      text: null,
      recommendation: null,
      facts: {
        topFaultZone: top?.zone ?? null,
        peakHour: peak?.hour ?? null,
        peakZone: peak?.zone ?? null,
        anomalies: anomalies.length,
        faultsTotal: faultsByZone.reduce((sum, z) => sum + z.count, 0),
      },
    },
  };
}

export const statisticsHandlers = [
  http.get(apiUrl('/statistics/periods'), () => denied() ?? reply({ data: listPeriods() })),
  http.get(apiUrl('/statistics/storage-fit'), ({ request }) => {
    return denied() ?? reply(storageFit(flag(new URL(request.url).searchParams.get('excludeGenerated'))));
  }),
  http.get(apiUrl('/statistics/period-comparison'), ({ request }) => {
    const blocked = denied();
    if (blocked) return blocked;
    const query = new URL(request.url).searchParams;
    const periods = listPeriods();
    const fallback = defaultComparison(periods);
    const a = periods.find((p) => p.id === (query.get('a') || fallback?.a.id));
    const b = periods.find((p) => p.id === (query.get('b') || fallback?.b.id));
    return a && b ? reply(compare(a, b)) : fail(404, 'NOT_FOUND', 'Perioada nu există.');
  }),
  http.get(apiUrl('/statistics/grid-insights'), ({ request }) => {
    return denied() ?? reply(gridInsights(flag(new URL(request.url).searchParams.get('excludeGenerated'))));
  }),
];
