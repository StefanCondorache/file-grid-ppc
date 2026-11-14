import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer, createSpeedMeter, ETA_CAP_S, speedEma } from './progress';
import { realClock } from './types';

describe('speed EMA (upload-engine.md §14)', () => {
  it('uses alpha 0.2 and starts from the first sample', () => {
    expect(speedEma(null, 100)).toBe(100);
    expect(speedEma(100, 200)).toBeCloseTo(120, 10);
    expect(speedEma(120, 0)).toBeCloseTo(96, 10);
  });

  it('converges to a steady rate', () => {
    let s: number | null = null;
    for (let i = 0; i < 60; i++) s = speedEma(s ?? 0, 1_000_000);
    expect(s).toBeCloseTo(1_000_000, -1);
  });
});

describe('speed meter and ETA', () => {
  const MB = 1_000_000;
  type Meter = ReturnType<typeof createSpeedMeter>;
  /** Samples at the snapshot cadence (250 ms) from `fromMs` to `untilMs`. */
  function feed(meter: Meter, fromMs: number, untilMs: number, doneAt: (t: number) => number, total: (t: number) => number) {
    for (let t = fromMs; t <= untilMs; t += 250) meter.sample(t, doneAt(t), total(t));
  }

  it('hides speed and ETA for the first 3 s of data', () => {
    const meter = createSpeedMeter();
    const done = (t: number) => t * 1000; // 1 MB/s
    const total = (t: number) => done(t) + 10 * MB; // always 10 MB left
    feed(meter, 0, 2750, done, total);
    expect(meter.read(2999)).toEqual({ speedBps: null, etaS: null });
    feed(meter, 3000, 3000, done, total);
    const { speedBps, etaS } = meter.read(3000);
    expect(speedBps).toBeCloseTo(MB, -3);
    expect(etaS).toBe(10);
  });

  it('caps the ETA at 24 h', () => {
    const meter = createSpeedMeter();
    feed(meter, 0, 4000, (t) => t / 1000, () => 10 * MB); // 1 byte/s
    expect(meter.read(4000).etaS).toBe(ETA_CAP_S);
  });

  it('forgets the old speed after a reset (pause, connection lost)', () => {
    const meter = createSpeedMeter();
    feed(meter, 0, 4000, (t) => t * 1000, () => 20 * MB);
    expect(meter.read(4000).speedBps).not.toBeNull();
    meter.reset();
    feed(meter, 10_000, 12_000, (t) => 4 * MB + (t - 10_000) * 1000, () => 20 * MB);
    expect(meter.read(12_000)).toEqual({ speedBps: null, etaS: null });
  });
});

describe('snapshot coalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes progress at most 4 times per second', async () => {
    const flush = vi.fn();
    const c = createCoalescer(realClock, flush);
    const tick = setInterval(() => c.schedule(), 5);
    await vi.advanceTimersByTimeAsync(300); // settle into the cadence
    flush.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(flush.mock.calls.length).toBeLessThanOrEqual(4);
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(3);
    clearInterval(tick);
    c.dispose();
  });

  it('flushes transitions at once', () => {
    const flush = vi.fn();
    const c = createCoalescer(realClock, flush);
    c.schedule();
    c.now();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1); // the pending progress flush was folded into the immediate one
  });
});
