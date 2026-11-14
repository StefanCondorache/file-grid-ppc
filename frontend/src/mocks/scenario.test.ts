// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@/lib/live/events';
import {
  CATEGORY_IDS, type Alert, type CategoryId, type GuaranteeStatus, type MeterCounters, type MetricsMatrix, type StorageHealth, type StorageId,
} from '@/lib/monitoring/contract';
import { createDb } from './db';
import { createScenario, type Scenario } from './scenario';

describe('scenario clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits ping with monotonic ids', () => {
    const s = createScenario();
    const seen: number[] = [];
    s.on((e) => { if (e.type === 'ping') seen.push(e.id); });
    s.start();
    vi.advanceTimersByTime(60_000);
    s.stop();
    expect(seen).toHaveLength(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(3);
  });

  it('delivers emitted events to every listener', () => {
    const s = createScenario();
    const a = vi.fn();
    const b = vi.fn();
    s.on(a);
    const off = s.on(b);
    s.emit('policy.updated', { category: 'fault', version: 4 });
    off();
    s.emit('policy.updated', { category: 'fault', version: 5 });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).toMatchObject({ type: 'policy.updated', data: { version: 4 } });
  });
});

/** An isolated scenario: its own in-memory db, jitter fixed by `random`. */
const make = (random = () => 0.5) => createScenario({ db: createDb(null), random });
const lastP95 = (s: Scenario, c: CategoryId) => s.series().find((x) => x.category === c)!.points.at(-1)!.p95Ms;
const OTHERS = CATEGORY_IDS.filter((c) => c !== 'fault_records');
const record = (s: Scenario) => {
  const events: StreamEvent[] = [];
  s.on((e) => { events.push(e); });
  return (type: StreamEvent['type']) => events.filter((e) => e.type === type).map((e) => e.data);
};
const guarantee = (s: Scenario, c: CategoryId) => s.guarantees().find((g) => g.category === c)!;

describe('monitoring scenario', () => {
  it('a fault storm raises fault p95 above 2 s within 3 ticks while the others stay under 1 s', () => {
    // Lowest, middle and highest jitter: the margins hold whatever Math.random returns.
    for (const r of [0, 0.5, 0.999]) {
      const s = make(() => r);
      expect(lastP95(s, 'fault_records')).toBeLessThan(1000);
      s.startStorm('fault_records', 10, 60);
      for (let i = 0; i < 3; i++) s.tick();
      expect(lastP95(s, 'fault_records')).toBeGreaterThan(2000);
      for (const c of OTHERS) expect(lastP95(s, c)).toBeLessThan(1000);
    }
  });

  it('a fault storm turns the fault guarantee at_risk and emits alert.raised; recovery resolves it', () => {
    const s = make();
    const seen = record(s);
    expect(s.guarantees().map((g) => g.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
    s.startStorm('fault_records', 10, 60);
    for (let i = 0; i < 3; i++) s.tick();

    const fault = guarantee(s, 'fault_records');
    expect(fault).toMatchObject({ state: 'at_risk', causeCode: 'FAULT_P95_ABOVE_TARGET', causeFacts: { targetMs: 2000 } });
    expect(fault.causeFacts.p95Ms).toBeGreaterThan(2000);
    for (const c of OTHERS) expect(guarantee(s, c).state).toBe('ok');
    const snapshot = seen('guarantees.status').at(-1) as { items: GuaranteeStatus[] };
    expect(snapshot.items.find((g) => g.category === 'fault_records')!.state).toBe('at_risk');

    const raised = seen('alert.raised') as Alert[];
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ category: 'fault_records', state: 'at_risk', causeCode: 'FAULT_P95_ABOVE_TARGET', resolvedAt: null, acknowledgedAt: null });
    expect(s.alerts('active').map((a) => a.id)).toEqual([raised[0]!.id]);

    s.stopStorm('fault_records');
    for (let i = 0; i < 5; i++) s.tick();
    expect(guarantee(s, 'fault_records').state).toBe('ok');
    expect(seen('alert.updated').at(-1)).toMatchObject({ id: raised[0]!.id, state: 'resolved' });
    expect(s.alerts('active')).toEqual([]);
    expect(seen('alert.raised')).toHaveLength(1);
  });

  it('S3 down emits storage.health with S3 down and updates db.storage; S3 back turns it ok', () => {
    const db = createDb(null);
    const s = createScenario({ db, random: () => 0.5 });
    const seen = record(s);
    const s3 = () => (seen('storage.health').at(-1) as { items: StorageHealth[] }).items.find((h) => h.storage === 's3');

    s.setStorage('S3', false);
    expect(s3()).toMatchObject({ status: 'down', latencyMs: null, circuitState: 'open' });
    expect((seen('storage.health').at(-1) as { items: StorageHealth[] }).items.filter((h) => h.storage !== 's3').map((h) => h.status)).toEqual(['ok', 'ok']);
    expect(db.storage.status('S3')).toBe('down');
    s.tick();
    expect(s.storageHealth().find((h) => h.storage === 's3')!.status).toBe('down');
    expect(s3()!.status).toBe('down');

    s.setStorage('s3', true);
    expect(db.storage.status('S3')).toBe('ok');
    expect(s3()).toMatchObject({ status: 'ok', circuitState: 'closed' });
    expect(s3()!.latencyMs).toBeGreaterThan(0);
  });

  it('lost stays 0 always: through a meter storm, an outage of their storage and every simulator mode', () => {
    const s = make();
    const seen = record(s);
    const ticks = (n: number) => { for (let i = 0; i < n; i++) s.tick(); };
    const before = s.counters();
    expect(before.lost).toBe(0);

    s.startStorm('meter_readings', 10, 60);
    ticks(3);
    expect(s.counters().ratePerS).toBe(100);
    expect(seen('simulator.status').at(-1)).toMatchObject({ mode: 'peak', ratePerS: 100 });

    s.setStorage('DB', false); // meters have no fallback here: readings wait in the simulator queue
    ticks(3);
    const stalled = s.counters();
    expect(s.simulator().queueDepth).toBeGreaterThan(0);
    expect(stalled.lost).toBe(0);
    s.setStorage('DB', true);
    ticks(1);
    expect(s.simulator().queueDepth).toBe(0);

    s.setSimulator('stopped');
    ticks(2);
    expect(s.counters().ratePerS).toBe(0);
    s.setSimulator('custom', 25);
    ticks(2);
    expect(s.counters().ratePerS).toBe(25);
    s.setSimulator('normal');
    ticks(2);

    const all = seen('meters.counters') as MeterCounters[];
    expect(all).toHaveLength(13);
    expect(all.every((c) => c.lost === 0)).toBe(true);
    expect(guarantee(s, 'meter_readings')).toMatchObject({ state: 'ok', metrics: expect.arrayContaining([expect.objectContaining({ key: 'lost', value: '0' })]) });

    const after = s.counters();
    expect(after.received).toBeGreaterThan(before.received);
    expect(after.received).toBe(after.unique + after.duplicatesRejected);
    expect(after.unique).toBe(after.byZone.reduce((n, z) => n + z.received, 0));
    expect(s.simulator()).toMatchObject({ mode: 'normal', ratePerS: 10, queueDepth: 0, sentUnique: after.unique, ackedUnique: after.unique });
  });

  it('matrix: 4 × 3 cells; while S3 is down fault writes land on the slower fallback and S3 records the failures', () => {
    const s = make();
    const cell = (m: MetricsMatrix, c: CategoryId, st: StorageId) => m.cells.find((x) => x.category === c && x.storage === st)!;
    const before = s.matrix('5m');
    expect(before).toMatchObject({ window: '5m' });
    expect(before.cells).toHaveLength(12);
    expect(cell(before, 'fault_records', 's3')).toMatchObject({ noTraffic: false, errorRate: 0 });
    expect(cell(before, 'fault_records', 'db')).toMatchObject({ noTraffic: true, requests: 0, p95Ms: null, errorRate: null });
    const { p50Ms, p95Ms, p99Ms } = cell(before, 'fault_records', 's3');
    expect(p50Ms!).toBeLessThan(p95Ms!);
    expect(p95Ms!).toBeLessThan(p99Ms!);

    s.setStorage('S3', false);
    for (let i = 0; i < 10; i++) s.tick();
    const during = s.matrix('5m');
    const fallback = cell(during, 'fault_records', 'ftp');
    expect(fallback).toMatchObject({ noTraffic: false, errorRate: 0 });
    expect(fallback.p95Ms!).toBeGreaterThan(cell(during, 'fault_records', 's3').p95Ms!);
    expect(cell(during, 'fault_records', 's3').errorRate!).toBeGreaterThan(0);
    expect(cell(during, 'meter_readings', 'db').errorRate).toBe(0);
  });

  it('bulkhead: a fault storm fills the fault compartment while the others keep room', () => {
    const s = make();
    s.startStorm('fault_records', 10, 60);
    for (let i = 0; i < 5; i++) s.tick();
    const b = s.bulkhead('15m');
    expect(b).toMatchObject({ window: '15m', stepS: 2 });
    expect(b.series.map((x) => [x.category, x.points.length])).toEqual(CATEGORY_IDS.map((c) => [c, 30]));
    const compartment = (c: CategoryId) => b.data.find((x) => x.category === c)!;
    expect(compartment('fault_records').queued).toBeGreaterThan(0);
    for (const c of OTHERS) expect(compartment(c).queued).toBe(0);
  });
});
