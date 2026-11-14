import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { apiUrl } from '@/lib/api/base';
import type { GridInsights, Period, PeriodComparison, StorageFit } from '@/features/statistics/contract';
import { createDb, db } from '../db';
import { SEED_PASSWORD } from '../seed/auth';
import { buildHandlers } from './index';

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'statistics'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());

const url = (p: string) => new URL(apiUrl(p), location.origin).href;
const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));

async function get<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  expect([path, res.status]).toEqual([path, 200]);
  return (await res.json()) as T;
}

const periods = async () => (await get<{ data: Period[] }>('/statistics/periods')).data;
const period = (id: string, kind: Period['kind'], start: string, end: string | null = null): Period => ({
  id, label: `${kind === 'peak' ? 'Furtună' : 'Zi normală'} · ${id}`, kind, origin: kind === 'peak' ? 'storm' : 'simulator', start, end,
});

beforeEach(async () => {
  localStorage.clear();
  db.reset();
  await login('auditor');
});

describe('statistics mock: periods (S2)', () => {
  it('defaults the comparison to the last normal period vs the most recent peak', async () => {
    const seeded = await periods();
    expect(seeded.map((p) => [p.label, p.kind])).toEqual([['Furtună · 14 nov 15:33', 'peak'], ['Zi normală · 12 nov', 'normal']]);
    const [storm, normal] = seeded as [Period, Period];

    const first = await get<PeriodComparison>('/statistics/period-comparison');
    expect([first.periodA.id, first.periodB.id]).toEqual([normal.id, storm.id]);
    // The storm hit the faults: their p95 climbs 0,6 s → 3,4 s (+467 %) while the bulkheads keep the rest flat.
    expect(first.rows.find((r) => r.category === 'fault_records' && r.metric === 'p95Ms')).toEqual({
      category: 'fault_records', metric: 'p95Ms', a: 600, b: 3400, deltaPct: 466.7,
    });
    expect(first.rows).toHaveLength(16);
    expect(first.interpretation).toMatchObject({ text: null, recommendation: null, facts: { mostAffected: 'fault_records', factor: 10, isolated: true } });

    // A newer normal day and an older peak: A follows the newest normal, B stays on the most recent peak.
    db.insert('periods', period('p-normal-13', 'normal', '2026-11-12T22:00:00.000Z', '2026-11-13T22:00:00.000Z'));
    db.insert('periods', period('p-peak-10', 'peak', '2026-11-10T08:00:00.000Z', '2026-11-10T08:20:00.000Z'));
    const next = await get<PeriodComparison>('/statistics/period-comparison');
    expect([next.periodA.id, next.periodB.id]).toEqual(['p-normal-13', storm.id]);

    // An explicit pair (the real contract's `a` and `b`) wins over the default; unknown ids are 404.
    const chosen = await get<PeriodComparison>(`/statistics/period-comparison?a=${normal.id}&b=p-peak-10`);
    expect([chosen.periodA.id, chosen.periodB.id]).toEqual([normal.id, 'p-peak-10']);
    const unknown = await fetch(url(`/statistics/period-comparison?a=${normal.id}&b=nu-exista`));
    expect([unknown.status, (await unknown.json()).code]).toEqual([404, 'NOT_FOUND']);
  });

  it('reads the periods from db.periods, newest first, so a new storm period is offered at once', async () => {
    const live = period('p-storm-live', 'peak', '2026-11-14T16:02:00.000Z');
    db.insert('periods', live);
    const listed = await periods();
    expect(listed[0]).toEqual(live);
    expect(listed).toHaveLength(3);
    expect((await get<PeriodComparison>('/statistics/period-comparison')).periodB.id).toBe('p-storm-live');

    db.remove<Period>('periods', (p) => p.id === 'p-storm-live');
    expect((await periods()).map((p) => p.id)).not.toContain('p-storm-live');
  });

  it('seeds the two labelled periods into a fresh db and keeps periods that already exist', async () => {
    const { seedStatistics } = await import('../seed/statistics');
    const fresh = createDb(null);
    expect(fresh.list('periods')).toEqual([]);
    seedStatistics(fresh);
    expect(fresh.list<Period>('periods').map((p) => p.label).sort()).toEqual(['Furtună · 14 nov 15:33', 'Zi normală · 12 nov']);

    const kept = createDb(null);
    kept.insert('periods', period('p-only', 'peak', '2026-11-14T16:02:00.000Z'));
    seedStatistics(kept);
    expect(kept.list<Period>('periods').map((p) => p.id)).toEqual(['p-only']);
    kept.reset();
    expect(kept.list('periods')).toHaveLength(2);
  });
});

describe('statistics mock: S1 and S3 facts', () => {
  const samples = (fit: StorageFit) => fit.items.flatMap((i) => i.storages).reduce((sum, s) => sum + s.samples, 0);
  const faults = (grid: GridInsights) => grid.faultsByZone.reduce((sum, z) => sum + z.count, 0);

  it('excludeGenerated changes the totals', async () => {
    const all = await get<StorageFit>('/statistics/storage-fit');
    const manual = await get<StorageFit>('/statistics/storage-fit?excludeGenerated=true');
    expect(samples(manual)).toBeGreaterThan(0);
    expect(samples(manual)).toBeLessThan(samples(all));
    // Meter readings are all simulator traffic: without generated data nothing is left to measure.
    const meterDb = (fit: StorageFit) => fit.items.find((i) => i.category === 'meter_readings')!.storages.find((s) => s.storage === 'db');
    expect(meterDb(all)!.samples).toBeGreaterThan(0);
    expect(meterDb(manual)).toEqual({ storage: 'db', samples: 0, p50Ms: null, p95Ms: null, throughputBps: null, errorRate: null });

    const grid = await get<GridInsights>('/statistics/grid-insights');
    const gridManual = await get<GridInsights>('/statistics/grid-insights?excludeGenerated=true');
    expect(faults(gridManual)).toBeGreaterThan(0);
    expect(faults(gridManual)).toBeLessThan(faults(grid));
    expect([gridManual.consumptionByHourZone, gridManual.anomalies]).toEqual([[], []]);
    expect(gridManual.interpretation.facts).toMatchObject({ anomalies: 0, peakHour: null });
  });

  it('S1: per category and storage, faults 0,6 s on S3 vs 1,8 s on FTP, primary storage from the live policy', async () => {
    const fit = await get<StorageFit>('/statistics/storage-fit');
    expect(fit.periodId).toBeNull();
    expect(fit.items.map((i) => [i.category, i.recommendedStorage])).toEqual([
      ['meter_readings', 'db'], ['fault_records', 's3'], ['connection_documents', 'db'], ['drone_videos', 's3'],
    ]);
    const fault = fit.items.find((i) => i.category === 'fault_records')!;
    expect(fault.storages.map((s) => [s.storage, s.p95Ms])).toEqual([['s3', 600], ['ftp', 1800], ['db', null]]);
    expect(fault.interpretation).toMatchObject({ text: null, recommendation: null, facts: { primaryStorage: 's3', fastest: 's3', runnerUp: 'ftp', speedup: 3 } });

    db.policies.put({ ...db.policies.get('fault')!, primaryStorage: 'FTP', fallbackStorage: 'S3' });
    const after = await get<StorageFit>('/statistics/storage-fit');
    expect(after.items.find((i) => i.category === 'fault_records')!.interpretation.facts).toMatchObject({ primaryStorage: 'ftp', fastest: 's3' });
  });

  it('S3: faults per zone, 24 h of consumption per zone, anomalies newest first', async () => {
    const grid = await get<GridInsights>('/statistics/grid-insights');
    expect(grid.faultsByZone.map((z) => [z.zone, z.county])).toEqual([['muntenia', null], ['banat', null], ['dobrogea', null]]);
    expect(grid.consumptionByHourZone).toHaveLength(72);
    expect(grid.anomalies.length).toBeGreaterThan(0);
    const times = grid.anomalies.map((a) => a.detectedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(grid.interpretation).toMatchObject({
      text: null, recommendation: null, facts: { topFaultZone: 'muntenia', peakZone: 'muntenia', peakHour: 19, anomalies: grid.anomalies.length },
    });
  });
});

describe('statistics mock: access', () => {
  it('needs a session with view_statistics', async () => {
    await login('teren');
    const forbidden = await fetch(url('/statistics/periods'));
    expect([forbidden.status, (await forbidden.json()).code]).toEqual([403, 'FORBIDDEN']);
    await unwrap(api.POST('/auth/logout'));
    const anonymous = await fetch(url('/statistics/storage-fit'));
    expect([anonymous.status, (await anonymous.json()).code]).toEqual([401, 'UNAUTHENTICATED']);
  });
});
