import { describe, expect, it } from 'vitest';
import { backoffMs, seededRng } from './backoff';

describe('full-jitter backoff', () => {
  it('keeps 1 000 seeded draws inside [0, min(cap, base·2^n)]', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 1000; i++) {
      const attempt = i % 12;
      const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
      const d = backoffMs(attempt, rng);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(ceiling);
      expect(Number.isInteger(d)).toBe(true);
    }
  });

  it('respects the cap at attempt 10', () => {
    expect(backoffMs(10, () => 0.999999)).toBeLessThanOrEqual(30_000);
    expect(backoffMs(10, () => 0.999999)).toBeGreaterThan(29_000);
  });

  it('is deterministic with a fixed rng', () => {
    expect(backoffMs(3, () => 0.5)).toBe(4000);
    expect(backoffMs(0, () => 0.5, 200, 1000)).toBe(100);
  });

  it('seeded rng repeats for the same seed and stays in [0, 1)', () => {
    const a = seededRng(7);
    const b = seededRng(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
