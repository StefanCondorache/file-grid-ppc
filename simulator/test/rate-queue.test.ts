import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fullJitterDelay, parseRetryAfter } from '../src/backoff.ts';
import { BoundedQueue } from '../src/queue.ts';
import { TokenBucket } from '../src/rate.ts';
import { seededRng } from '../src/readings.ts';

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function runFor(bucket: TokenBucket, clock: ReturnType<typeof fakeClock>, ms: number, stepMs: number): number {
  let taken = 0;
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    clock.advance(stepMs);
    taken += bucket.take(Number.POSITIVE_INFINITY);
  }
  return taken;
}

describe('token bucket', () => {
  it('produces the configured rate within 1% over 10 s (50 ms ticks)', () => {
    for (const rate of [10, 100, 1000]) {
      const clock = fakeClock();
      const bucket = new TokenBucket({ ratePerS: rate, now: clock.now });
      const taken = runFor(bucket, clock, 10_000, 50);
      assert.ok(Math.abs(taken - rate * 10) <= rate * 10 * 0.01 + 1, `rate ${rate}: took ${taken}`);
    }
  });

  it('handles fractional rates and irregular ticks', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerS: 2.5, now: clock.now });
    let taken = 0;
    for (let i = 0; i < 400; i += 1) {
      clock.advance(i % 3 === 0 ? 7 : 113);
      taken += bucket.take(Number.POSITIVE_INFINITY);
    }
    const seconds = clock.now() / 1000;
    assert.ok(Math.abs(taken - 2.5 * seconds) <= 1, `took ${taken} in ${seconds}s`);
  });

  it('caps the burst after an idle period at one second of tokens', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerS: 100, now: clock.now });
    clock.advance(60_000);
    assert.equal(bucket.take(Number.POSITIVE_INFINITY), 100);
    assert.equal(bucket.take(Number.POSITIVE_INFINITY), 0);
  });

  it('never takes more than asked', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerS: 100, now: clock.now });
    clock.advance(1000);
    assert.equal(bucket.take(30), 30);
    assert.equal(bucket.take(Number.POSITIVE_INFINITY), 70);
  });

  it('switches rate on the fly and produces nothing at rate 0', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerS: 10, now: clock.now });
    assert.equal(runFor(bucket, clock, 1000, 50), 10);
    bucket.setRate(100);
    assert.equal(runFor(bucket, clock, 1000, 50), 100);
    bucket.setRate(0);
    assert.equal(runFor(bucket, clock, 5000, 50), 0);
  });
});

describe('bounded queue', () => {
  it('refuses pushes when full instead of dropping', () => {
    const q = new BoundedQueue<number>(3);
    assert.equal(q.push(1), true);
    assert.equal(q.push(2), true);
    assert.equal(q.push(3), true);
    assert.equal(q.push(4), false);
    assert.deepEqual(q.take(10), [1, 2, 3]);
  });

  it('keeps taken items counted until they are settled', () => {
    const q = new BoundedQueue<number>(3);
    q.push(1);
    q.push(2);
    q.push(3);
    assert.deepEqual(q.take(2), [1, 2]);
    assert.equal(q.queued, 1);
    assert.equal(q.inFlight, 2);
    assert.equal(q.depth, 3);
    assert.equal(q.push(4), false, 'in-flight items still occupy room');
    q.settle(2);
    assert.equal(q.free, 2);
    assert.equal(q.push(4), true);
    assert.deepEqual(q.take(5), [3, 4]);
    assert.throws(() => q.settle(3), RangeError);
  });

  it('stays FIFO across many pushes and takes (compaction)', () => {
    const q = new BoundedQueue<number>(5000);
    let next = 0;
    let expected = 0;
    for (let round = 0; round < 50; round += 1) {
      while (q.free > 0) q.push(next++);
      const taken = q.take(1500);
      for (const v of taken) assert.equal(v, expected++);
      q.settle(taken.length);
    }
  });
});

describe('backoff', () => {
  it('uses full jitter within an exponentially growing, capped window', () => {
    const rng = seededRng(9);
    for (let failures = 1; failures <= 12; failures += 1) {
      const window = Math.min(15_000, 500 * 2 ** (failures - 1));
      for (let i = 0; i < 200; i += 1) {
        const d = fullJitterDelay(failures, rng);
        assert.ok(d >= 0 && d <= window, `failure ${failures}: ${d} > ${window}`);
      }
    }
    assert.equal(fullJitterDelay(20, () => 0.999_999), 14_999);
  });

  it('parses Retry-After seconds and HTTP dates, ignoring junk', () => {
    const now = Date.parse('2026-11-14T10:00:00Z');
    assert.equal(parseRetryAfter('7', now), 7000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
    assert.equal(parseRetryAfter('Sat, 14 Nov 2026 10:00:03 GMT', now), 3000);
    assert.equal(parseRetryAfter('99999', now), 60_000);
    assert.equal(parseRetryAfter(null, now), undefined);
    assert.equal(parseRetryAfter('soon', now), undefined);
    assert.equal(parseRetryAfter('-5', now), undefined);
  });
});
