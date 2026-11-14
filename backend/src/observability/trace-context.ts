import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/**
 * Trace ids and lightweight spans. Each HTTP request runs inside a trace (trace.middleware.ts);
 * code times its steps with `span('storage.put', { storage }, async (attrs) => ...)` and the
 * finished spans stay on the trace so the whole operation can be logged and stored.
 */

export type SpanAttributes = Record<string, unknown>;

export interface SpanRecord {
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
  readonly attrs: SpanAttributes;
}

export class Trace {
  readonly startedAt = performance.now();
  readonly spans: SpanRecord[] = [];

  constructor(readonly traceId: string) {}

  elapsedMs(): number {
    return performance.now() - this.startedAt;
  }
}

const storage = new AsyncLocalStorage<Trace>();
const TRACE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function newTraceId(): string {
  return randomUUID().replaceAll('-', '');
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

export function currentTrace(): Trace | undefined {
  return storage.getStore();
}

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/** Run `fn` with a fresh trace as the current one (nested calls restore the outer trace). */
export function runWithTrace<T>(traceId: string, fn: (trace: Trace) => T): T {
  const trace = new Trace(traceId);
  return storage.run(trace, () => fn(trace));
}

/** Time one step of the current operation. `fn` may add attributes to the span. */
export async function span<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (attrs: SpanAttributes) => Promise<T>,
): Promise<T> {
  const trace = storage.getStore();
  const attributes: SpanAttributes = { ...attrs };
  const start = performance.now();
  let failure: string | undefined;
  try {
    return await fn(attributes);
  } catch (error) {
    failure = error instanceof Error ? error.constructor.name : 'Error';
    throw error;
  } finally {
    trace?.spans.push({
      name,
      startMs: start - trace.startedAt,
      durationMs: performance.now() - start,
      status: failure ? 'error' : 'ok',
      ...(failure ? { error: failure } : {}),
      attrs: { ...attributes },
    });
  }
}
