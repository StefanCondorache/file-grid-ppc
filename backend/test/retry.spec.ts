import { RetryTimeoutError, retryWithBackoff } from '../src/lifecycle/retry';

/** A fake clock: sleeping moves it forward instead of waiting. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const failing = (failures: number, error = new Error('getaddrinfo ENOTFOUND postgres')) => {
  let calls = 0;
  const fn = jest.fn(async () => {
    calls += 1;
    if (calls <= failures) throw error;
    return `ok after ${calls}`;
  });
  return fn;
};

describe('retryWithBackoff', () => {
  it('returns the first success without waiting', async () => {
    const time = fakeTime();
    const fn = failing(0);

    await expect(
      retryWithBackoff(fn, { timeoutMs: 90_000, minDelayMs: 500, maxDelayMs: 5000, ...time }),
    ).resolves.toBe('ok after 1');
    expect(time.sleeps).toEqual([]);
  });

  it('retries with doubling delays capped at maxDelayMs, reporting each failure', async () => {
    const time = fakeTime();
    const fn = failing(6);
    const retries: { attempt: number; delayMs: number }[] = [];

    const result = await retryWithBackoff(fn, {
      timeoutMs: 90_000,
      minDelayMs: 500,
      maxDelayMs: 5000,
      onRetry: (_error, attempt, delayMs) => retries.push({ attempt, delayMs }),
      ...time,
    });

    expect(result).toBe('ok after 7');
    expect(time.sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fn).toHaveBeenCalledTimes(7);
  });

  it('gives up once the time budget is spent, with the last error and the attempt count', async () => {
    const time = fakeTime();
    const error = new Error('connect ECONNREFUSED 10.43.0.10:5432');
    const fn = failing(Number.POSITIVE_INFINITY, error);

    const outcome = retryWithBackoff(fn, {
      timeoutMs: 10_000,
      minDelayMs: 1000,
      maxDelayMs: 4000,
      ...time,
    });

    await expect(outcome).rejects.toBeInstanceOf(RetryTimeoutError);
    await expect(outcome).rejects.toMatchObject({ lastError: error });
    // 1 + 2 + 4 + 3 (the last wait is cut to what is left of the budget) = 10 s
    expect(time.sleeps).toEqual([1000, 2000, 4000, 3000]);
    expect(time.now()).toBe(10_000);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('stops retrying when the signal is aborted', async () => {
    const controller = new AbortController();
    const fn = jest.fn(async () => {
      controller.abort();
      throw new Error('down');
    });

    await expect(
      retryWithBackoff(fn, {
        timeoutMs: 90_000,
        minDelayMs: 10,
        maxDelayMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits for real by default and can be aborted while waiting', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);

    await expect(
      retryWithBackoff(
        async () => {
          throw new Error('down');
        },
        { timeoutMs: 60_000, minDelayMs: 30_000, maxDelayMs: 30_000, signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
