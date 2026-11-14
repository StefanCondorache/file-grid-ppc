// Drains the reading queue to POST {BACKEND_URL}/api/v1/meter-readings in batches.
//
// Guarantees:
// - a batch is retried unchanged (same reading ids) until it is acknowledged: network errors, timeouts, 429, 5xx
//   and any other unexpected status back off and retry forever; 401/403 pause 10 s and retry;
// - only 400/422 drop a batch (it can never succeed) and count its readings as rejected;
// - while a batch waits to be retried, no newer batch is started, so a failing batch stays at the head;
// - `sent_total` counts each reading once when its first attempt starts, `acked_total` once on its 200.

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fullJitterDelay, parseRetryAfter } from './backoff.ts';
import type { Logger } from './log.ts';
import type { SimMetrics } from './metrics.ts';
import type { BoundedQueue } from './queue.ts';
import type { Clock } from './rate.ts';
import type { Reading, Rng } from './readings.ts';

export const READINGS_PATH = '/api/v1/meter-readings';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_PAUSE_MS = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_ACKED_RING_SIZE = 1000;
const LOG_BODY_LIMIT = 300;
const DRAIN_POLL_MS = 25;

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export interface Batch {
  readonly seq: number;
  readonly fresh: readonly Reading[];
  readonly duplicates: readonly Reading[];
}

export interface AckResponse {
  readonly received?: number;
  readonly stored?: number;
  readonly duplicates?: number;
  readonly traceId?: string;
}

type Outcome =
  | { readonly kind: 'acked'; readonly response: AckResponse | undefined }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'auth' }
  | { readonly kind: 'retry'; readonly retryAfterMs: number | undefined };

export interface SenderOptions {
  readonly backendUrl: string;
  readonly apiKey: string;
  readonly batchMax: number;
  readonly flushIntervalMs: number;
  readonly duplicateRatio: number;
  readonly queue: BoundedQueue<Reading>;
  readonly metrics: SimMetrics;
  readonly log: Logger;
  readonly fetch?: FetchFn;
  readonly rng?: Rng;
  readonly now?: Clock;
  readonly sleep?: SleepFn;
  readonly requestTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly authPauseMs?: number;
  readonly maxInFlight?: number;
  readonly ackedRingSize?: number;
}

/** Fixed-size ring of recently acknowledged readings, the source of deliberate duplicates. */
export class AckedRing {
  readonly #items: Reading[] = [];
  readonly #capacity: number;
  #next = 0;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.#items.length;
  }

  add(reading: Reading): void {
    if (this.#items.length < this.#capacity) this.#items.push(reading);
    else this.#items[this.#next] = reading;
    this.#next = (this.#next + 1) % this.#capacity;
  }

  /** Up to `count` distinct readings picked at random. */
  sample(count: number, rng: Rng): Reading[] {
    const n = Math.min(count, this.#items.length);
    const picked = new Set<number>();
    while (picked.size < n) picked.add(Math.floor(rng() * this.#items.length));
    return [...picked].map((i) => this.#items[i] as Reading);
  }
}

function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return 'request timed out';
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return `${err.message}${cause}`;
}

function parseAck(text: string): AckResponse | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as AckResponse) : undefined;
  } catch {
    return undefined;
  }
}

const defaultSleep: SleepFn = (ms, signal) => delay(ms, undefined, { signal });

export class Sender {
  readonly #o: SenderOptions;
  readonly #url: string;
  readonly #fetch: FetchFn;
  readonly #rng: Rng;
  readonly #now: Clock;
  readonly #sleep: SleepFn;
  readonly #maxInFlight: number;
  readonly #ring: AckedRing;
  readonly #abort = new AbortController();
  #active = 0;
  #retrying = 0;
  #pausedUntil = 0;
  #batchSeq = 0;
  #draining = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SenderOptions) {
    this.#o = options;
    this.#url = `${options.backendUrl}${READINGS_PATH}`;
    this.#fetch = options.fetch ?? fetch;
    this.#rng = options.rng ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#ring = new AckedRing(options.ackedRingSize ?? DEFAULT_ACKED_RING_SIZE);
  }

  get activeRequests(): number {
    return this.#active;
  }

  get ackedRingSize(): number {
    return this.#ring.size;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => this.flush(), this.#o.flushIntervalMs);
  }

  /** New readings were queued: send at once if a full batch is ready. */
  notify(): void {
    this.#pump(false);
  }

  /** Sends whatever is queued, even a partial batch (runs every FLUSH_INTERVAL_MS). */
  flush(): void {
    this.#pump(true);
  }

  /** Flushes until every queued and in-flight reading is settled or the timeout passes. */
  async drain(timeoutMs: number): Promise<boolean> {
    this.#draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.#o.queue.depth > 0 && !this.#stopped && Date.now() < deadline) {
      this.#pump(true);
      await delay(Math.min(DRAIN_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    return this.#o.queue.depth === 0;
  }

  /** Stops timers and aborts in-flight requests and backoff waits. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
  }

  #canStart(): boolean {
    return (
      !this.#stopped &&
      this.#active < this.#maxInFlight &&
      this.#retrying === 0 &&
      this.#now() >= this.#pausedUntil &&
      this.#o.queue.queued > 0
    );
  }

  #pump(partial: boolean): void {
    while (this.#canStart()) {
      const ready = partial || this.#draining || this.#o.queue.queued >= this.#o.batchMax;
      if (!ready) return;
      const batch = this.#buildBatch();
      this.#active += 1;
      this.#deliver(batch)
        .catch((err: unknown) => this.#o.log.error('meter batch delivery failed', { batch: batch.seq, error: describeError(err) }))
        .finally(() => {
          this.#active -= 1;
          this.#pump(false);
        });
    }
  }

  #buildBatch(): Batch {
    const { batchMax, duplicateRatio, queue } = this.#o;
    const candidates = Math.min(queue.queued, batchMax);
    let wanted = 0;
    if (duplicateRatio > 0 && this.#ring.size > 0) {
      for (let i = 0; i < candidates; i += 1) if (this.#rng() < duplicateRatio) wanted += 1;
    }
    const duplicates = this.#ring.sample(Math.min(wanted, batchMax - 1), this.#rng);
    const fresh = queue.take(batchMax - duplicates.length);
    this.#batchSeq += 1;
    return { seq: this.#batchSeq, fresh, duplicates };
  }

  async #deliver(batch: Batch): Promise<void> {
    const { metrics } = this.#o;
    const body = JSON.stringify({ readings: [...batch.fresh, ...batch.duplicates] });
    for (const r of batch.fresh) metrics.readingsSent.inc({ zone: r.zone });
    if (batch.duplicates.length > 0) metrics.duplicatesSent.inc({}, batch.duplicates.length);

    let failures = 0;
    let waitingForRetry = false;
    try {
      while (!this.#stopped) {
        if (failures > 0) metrics.retries.inc();
        const outcome = await this.#attempt(batch, body, failures);
        if (outcome.kind === 'acked') {
          this.#acked(batch, outcome.response);
          return;
        }
        if (outcome.kind === 'rejected') {
          this.#rejected(batch);
          return;
        }
        failures += 1;
        if (!waitingForRetry) {
          waitingForRetry = true;
          this.#retrying += 1;
        }
        if (!(await this.#wait(this.#retryDelay(outcome, failures)))) return; // stopped: batch abandoned
      }
    } finally {
      if (waitingForRetry) this.#retrying -= 1;
    }
  }

  /** Sleeps unless the sender is stopped first; false means stopped. */
  async #wait(ms: number): Promise<boolean> {
    try {
      await this.#sleep(ms, this.#abort.signal);
      return !this.#stopped;
    } catch {
      return false;
    }
  }

  #retryDelay(outcome: Outcome, failures: number): number {
    if (outcome.kind === 'auth') {
      this.#pausedUntil = this.#now() + (this.#o.authPauseMs ?? DEFAULT_AUTH_PAUSE_MS);
      return this.#o.authPauseMs ?? DEFAULT_AUTH_PAUSE_MS;
    }
    if (outcome.kind === 'retry' && outcome.retryAfterMs !== undefined) return outcome.retryAfterMs;
    return fullJitterDelay(failures, this.#rng, this.#o.backoffBaseMs, this.#o.backoffCapMs);
  }

  #acked(batch: Batch, response: AckResponse | undefined): void {
    const { metrics, queue } = this.#o;
    for (const r of batch.fresh) {
      metrics.readingsAcked.inc({ zone: r.zone });
      this.#ring.add(r);
    }
    if (typeof response?.duplicates === 'number' && response.duplicates >= 0) {
      metrics.backendDuplicates.inc({}, response.duplicates);
    }
    queue.settle(batch.fresh.length);
  }

  #rejected(batch: Batch): void {
    this.#o.metrics.readingsRejected.inc({}, batch.fresh.length);
    this.#o.queue.settle(batch.fresh.length);
  }

  async #attempt(batch: Batch, body: string, failures: number): Promise<Outcome> {
    try {
      return await this.#request(batch, body, failures);
    } catch (err) {
      this.#o.log.error('unexpected error while sending meter batch, will retry', { batch: batch.seq, error: describeError(err) });
      return { kind: 'retry', retryAfterMs: undefined };
    }
  }

  async #request(batch: Batch, body: string, failures: number): Promise<Outcome> {
    const { log, metrics } = this.#o;
    const traceId = newTraceId();
    const size = batch.fresh.length + batch.duplicates.length;
    const context = { traceId, batch: batch.seq, readings: size, attempt: failures + 1 };
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.#o.apiKey, 'X-Trace-Id': traceId },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(this.#o.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS), this.#abort.signal]),
      });
    } catch (err) {
      metrics.requests.inc({ status: 'network' });
      if (!this.#stopped) log.warn('meter batch send failed, will retry', { ...context, error: describeError(err) });
      return { kind: 'retry', retryAfterMs: undefined };
    }
    metrics.requests.inc({ status: String(res.status) });
    const text = await res.text().catch(() => '');
    return this.#classify(res, text, context);
  }

  #classify(res: Response, text: string, context: Record<string, unknown>): Outcome {
    const { log } = this.#o;
    const status = res.status;
    if (status >= 200 && status < 300) {
      const response = parseAck(text);
      log.debug('meter batch acknowledged', { ...context, status, ...response });
      return { kind: 'acked', response };
    }
    const detail = { ...context, status, body: text.slice(0, LOG_BODY_LIMIT) };
    if (status === 400 || status === 422) {
      log.error('backend rejected meter batch, dropping it', detail);
      return { kind: 'rejected' };
    }
    if (status === 401 || status === 403) {
      log.error('backend refused the meter API key, pausing before retry (check METER_API_KEY)', detail);
      return { kind: 'auth' };
    }
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.#now());
    log.warn('backend did not accept meter batch, will retry', { ...detail, retryAfterMs });
    return { kind: 'retry', retryAfterMs };
  }
}
