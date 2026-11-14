// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@/lib/live/events';
import { CATEGORY_IDS, type Alert, type CategoryId, type GuaranteeStatus } from '@/lib/monitoring/contract';
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
});
