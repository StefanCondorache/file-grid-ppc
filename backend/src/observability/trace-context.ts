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
  /** Attributes of the whole request (method, path, upload id...): the root `api` span. */
  readonly attributes: SpanAttributes = {};

  constructor(
    readonly traceId: string,
    /** The client of the HTTP request (src/common/client-ip.ts); null for background work. */
    readonly clientIp: string | null = null,
  ) {}

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

/** The client IP of the current HTTP request, if any. */
export function currentClientIp(): string | null {
  return storage.getStore()?.clientIp ?? null;
}

/** Run `fn` with a fresh trace as the current one (nested calls restore the outer trace). */
export function runWithTrace<T>(
  traceId: string,
  fn: (trace: Trace) => T,
  clientIp: string | null = null,
): T {
  const trace = new Trace(traceId, clientIp);
  return storage.run(trace, () => fn(trace));
}

/** Add attributes to the whole current request (the root `api` span of its trace). */
export function annotate(attrs: SpanAttributes): void {
  const trace = storage.getStore();
  if (trace) Object.assign(trace.attributes, attrs);
}

/**
 * Record a step that was timed by hand, for work interleaved with another step (encryption runs
 * chunk by chunk inside the storage write). `startedAt` is a `performance.now()` timestamp.
 */
export function recordSpan(
  name: string,
  startedAt: number,
  durationMs: number,
  attrs: SpanAttributes,
): void {
  const trace = storage.getStore();
  trace?.spans.push({
    name,
    startMs: startedAt - trace.startedAt,
    durationMs,
    status: 'ok',
    attrs: { ...attrs },
  });
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
