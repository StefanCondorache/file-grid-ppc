import { setTimeout as delay } from 'node:timers/promises';

/** Every attempt failed and the time budget is spent. */
export class RetryTimeoutError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(`gave up after ${attempts} attempts: ${reason}`);
    this.name = 'RetryTimeoutError';
  }
}

export interface RetryOptions {
  /** Total time budget, counted from the first attempt. */
  readonly timeoutMs: number;
  /** First wait; it doubles after every failure, up to maxDelayMs. */
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  /** Aborting stops the retries (and a wait in progress) with an AbortError. */
  readonly signal?: AbortSignal;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Test hooks. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const realSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal });
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('retry aborted', 'AbortError');
}

/**
 * Calls `fn` until it succeeds, waiting minDelayMs, 2x, 4x ... (at most maxDelayMs) between
 * attempts, for at most timeoutMs in total; then throws RetryTimeoutError with the last error.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const deadline = now() + options.timeoutMs;
  let wait = options.minDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await fn(attempt);
    } catch (error) {
      throwIfAborted(options.signal);
      const left = deadline - now();
      if (left <= 0) throw new RetryTimeoutError(attempt, error);
      const pause = Math.min(wait, left);
      options.onRetry?.(error, attempt, pause);
      try {
        await sleep(pause, options.signal);
      } catch {
        throwIfAborted(options.signal);
      }
      wait = Math.min(wait * 2, options.maxDelayMs);
    }
  }
}
