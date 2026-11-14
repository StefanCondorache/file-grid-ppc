import { performance } from 'node:perf_hooks';

/** Helpers shared by the adapters and the resilience layer (not part of the public contract). */

export const MiB = 1024 * 1024;

export function elapsedMs(startMs: number): number {
  return performance.now() - startMs;
}

/** An error whose cause is a Node system error code (ECONNREFUSED, ETIMEDOUT, ...), if any. */
export function systemErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/** Short, credential-free description of an unexpected error: its code or class name. */
export function errorKind(error: unknown): string {
  const code = systemErrorCode(error);
  if (code) return code;
  if (error instanceof Error) {
    // Some libraries use non-class names (pg's DatabaseError is named "error").
    return /^[A-Z]/.test(error.name) ? error.name : error.constructor.name || 'Error';
  }
  return typeof error;
}

/** The reason of an aborted signal as an Error (AbortSignal reasons may be anything). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Sleep `ms`, rejecting early with the abort reason when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve with `promise`, or reject with the abort reason as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Run `onAbort` once if `signal` aborts; returns a function that removes the listener. */
export function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    handler();
    return () => undefined;
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

/** Counting semaphore whose waiters can give up through an AbortSignal. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        removeListener();
        resolve();
      };
      const removeListener = onAbort(signal, () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal as AbortSignal));
      });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

/** Serializes async sections (an asyncio.Lock equivalent). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
