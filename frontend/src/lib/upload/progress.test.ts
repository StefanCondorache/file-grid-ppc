import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateTracker, createThrottle, speedEma } from './progress';
import { realClock } from './types';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('speed and ETA', () => {
  it('smooths speed with an EMA of alpha 0.2', () => {
    expect(speedEma(null, 100)).toBe(100);
    expect(speedEma(100, 200)).toBeCloseTo(120);
  });

  it('hides speed and ETA for the first 3 s, then estimates them', () => {
    const t = createRateTracker(realClock);
    t.reset(0);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(500);
      t.sample(i * 500_000); // 1 MB/s
      if (i < 6) expect(t.speed()).toBeNull();
    }
    vi.advanceTimersByTime(500);
    t.sample(3_000_000);
    expect(t.speed()).toBeCloseTo(1_000_000, -3);
    expect(t.eta(10_000_000)).toBeCloseTo(10, 0);
  });

  it('ignores samples closer than 500 ms and restarts after a reset', () => {
    const t = createRateTracker(realClock);
    t.reset(0);
    vi.advanceTimersByTime(3500);
    t.sample(3_500_000);
    vi.advanceTimersByTime(100);
    t.sample(9_000_000); // too soon: ignored
    expect(t.speed()).toBeCloseTo(1_000_000, -3);
    t.reset(3_500_000);
    expect(t.speed()).toBeNull();
    expect(t.eta(1)).toBeNull();
  });
});

describe('4 Hz throttle', () => {
  it('calls at most 4 times per second, and flush calls at once', () => {
    const fn = vi.fn();
    const th = createThrottle(fn, 250, realClock);
    for (let i = 0; i < 10; i++) {
      th.schedule();
      vi.advanceTimersByTime(99);
    }
    expect(fn.mock.calls.length).toBeLessThanOrEqual(4);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    const before = fn.mock.calls.length;
    th.flush();
    expect(fn.mock.calls.length).toBe(before + 1);
    vi.advanceTimersByTime(1000);
    expect(fn.mock.calls.length).toBe(before + 1); // the pending call was absorbed by the flush
  });
});
