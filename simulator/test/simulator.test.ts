import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import { seededRng } from '../src/readings.ts';
import type { Reading } from '../src/readings.ts';
import { Simulator } from '../src/simulator.ts';
import type { FetchFn } from '../src/sender.ts';
import { memoryLogger, testConfig, waitFor } from './helpers.ts';

function fakeClock(start = Date.parse('2026-11-14T10:00:00Z')): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** A fetch that holds every request until `release()`, then answers 200 (simulates a stalled backend). */
function stalledFetch() {
  const pending: Array<() => void> = [];
  const bodies: Reading[][] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    const readings = (JSON.parse(String(init?.body)) as { readings: Reading[] }).readings;
    bodies.push(readings);
    await new Promise<void>((resolve) => pending.push(resolve));
    return new Response(JSON.stringify({ received: readings.length, stored: readings.length, duplicates: 0 }), {
      status: 200,
    });
  };
  const release = (): void => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return { fetchFn, bodies, release };
}

describe('generator and backpressure', () => {
  const sims: Simulator[] = [];
  after(() => {
    for (const s of sims) s.stop();
  });

  it('pauses generation when the queue is full, drops nothing and resumes when acks free room', async () => {
    const clock = fakeClock();
    const stalled = stalledFetch();
    const sim = new Simulator({
      config: testConfig({ meterRate: 100, maxQueue: 500, batchMax: 100 }),
      log: silentLogger,
      now: clock.now,
      rng: seededRng(21),
      sequenceBase: 1,
      sender: { fetch: stalled.fetchFn },
    });
    sims.push(sim);

    let generated = 0;
    for (let i = 0; i < 200; i += 1) {
      clock.advance(50); // 10 s at 100/s would be 1000 readings
      generated += sim.tick();
    }
    assert.equal(generated, 500, 'generation stops exactly at MAX_QUEUE');
    assert.equal(sim.queue.depth, 500);
    assert.equal(sim.backpressure, true);
    assert.equal(sim.queue.inFlight, 200, 'two batches of 100 are in flight, stalled');
    assert.equal(sim.tick(), 0);

    stalled.release();
    await waitFor(() => sim.queue.inFlight === 200 && sim.metrics.readingsAcked.total() === 200);
    clock.advance(1000);
    const resumed = sim.tick();
    assert.ok(resumed > 0 && resumed <= 200, `generation resumed with ${resumed}`);
    assert.equal(sim.backpressure, sim.queue.free === 0);

    // nothing was dropped: every generated reading is either acked or still unsettled in the queue
    generated += resumed;
    for (let round = 0; round < 20 && sim.queue.depth > 0; round += 1) {
      stalled.release();
      sim.sender.flush();
      await new Promise((r) => setTimeout(r, 10));
    }
    stalled.release();
    await waitFor(() => {
      stalled.release();
      sim.sender.flush();
      return sim.queue.depth === 0;
    });
    assert.equal(sim.metrics.readingsAcked.total(), generated);
    const sentIds = new Set(stalled.bodies.flat().map((r) => r.readingId));
    assert.equal(sentIds.size, generated);
  });

  it('generates at the normal rate, 10x in peak with origin storm, and nothing when stopped', () => {
    const clock = fakeClock();
    const stalled = stalledFetch();
    const sim = new Simulator({
      config: testConfig({ meterRate: 20, stormFactor: 10, maxQueue: 100_000, batchMax: 500 }),
      log: silentLogger,
      now: clock.now,
      rng: seededRng(22),
      sequenceBase: 1,
      sender: { fetch: stalled.fetchFn },
    });
    sims.push(sim);
    const runSeconds = (s: number): number => {
      let n = 0;
      for (let i = 0; i < s * 20; i += 1) {
        clock.advance(50);
        n += sim.tick();
      }
      return n;
    };
    const normal = runSeconds(10);
    assert.ok(Math.abs(normal - 200) <= 2, `normal ${normal}`);

    sim.applyControl({ mode: 'peak', durationS: 10 });
    const peak = runSeconds(10);
    assert.ok(Math.abs(peak - 2000) <= 25, `peak ${peak}`);
    assert.equal(sim.status().mode, 'normal', 'the 10 s storm returned to normal by itself');

    sim.applyControl({ mode: 'stopped' });
    assert.equal(runSeconds(5), 0);
    assert.equal(sim.status().ratePerS, 0);

    sim.applyControl({ mode: 'custom', ratePerS: 50 });
    assert.ok(Math.abs(runSeconds(4) - 200) <= 2);
  });

  it('labels readings generated during peak with origin storm', () => {
    const clock = fakeClock();
    const stalled = stalledFetch();
    const sim = new Simulator({
      config: testConfig({ meterRate: 10, batchMax: 1 }),
      log: silentLogger,
      now: clock.now,
      rng: seededRng(23),
      sequenceBase: 1,
      sender: { fetch: stalled.fetchFn },
    });
    sims.push(sim);
    clock.advance(500);
    sim.tick();
    sim.applyControl({ mode: 'peak' });
    clock.advance(500);
    sim.tick();
    const generated = [...stalled.bodies.flat(), ...sim.queue.take(1000)]; // sent (stalled) plus still queued
    const origins = generated.map((r) => r.origin);
    assert.equal(generated.length, 5 + 50); // 0.5 s at 10/s, then 0.5 s at 100/s
    assert.ok(origins.includes('simulator') && origins.includes('storm'), origins.join(','));
    sim.applyControl({ mode: 'normal' });
    assert.equal(sim.controller.origin(), 'simulator');
  });

  it('reports the control status including queue depth and stormEndsAt', () => {
    const clock = fakeClock();
    const sim = new Simulator({ config: testConfig(), log: silentLogger, now: clock.now, sequenceBase: 1 });
    sims.push(sim);
    assert.deepEqual(sim.status(), {
      mode: 'normal',
      ratePerS: 10,
      normalRatePerS: 10,
      peakRatePerS: 100,
      queueDepth: 0,
      stormEndsAt: null,
      sentUnique: 0,
      ackedUnique: 0,
    });
    const status = sim.applyControl({ mode: 'peak', durationS: 90 });
    assert.equal(status.stormEndsAt, '2026-11-14T10:01:30.000Z');
    assert.equal(status.ratePerS, 100);
  });
});

describe('summary log', () => {
  let sim: Simulator;
  const { log, lines } = memoryLogger();
  before(() => {
    sim = new Simulator({ config: testConfig(), log, sequenceBase: 1 });
  });
  after(() => sim.stop());

  it('logs one JSON line with rate, sent, acked and queue, never the key', () => {
    sim.logSummary();
    const line = lines.find((l) => l.includes('simulator summary'));
    assert.ok(line);
    const entry = JSON.parse(line) as Record<string, unknown>;
    for (const key of ['level', 'time', 'message', 'mode', 'ratePerS', 'sent', 'acked', 'queueDepth']) {
      assert.ok(key in entry, key);
    }
    assert.equal(entry.level, 'info');
    assert.ok(lines.every((l) => !l.includes(testConfig().apiKey)));
  });
});
