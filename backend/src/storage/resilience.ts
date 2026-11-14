import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import {
  type HealthStatus,
  IntegrityError,
  InvalidKey,
  ObjectNotFound,
  type PutResult,
  type StorageAdapter,
  type StorageCallOptions,
  StorageError,
  type StorageName,
  StorageUnavailable,
  closeQuietly,
  validateKey,
} from './base';
import { abortReason, abortable, elapsedMs, errorKind, onAbort, throwIfAborted } from './internal';
import {
  BYTES_TOTAL,
  CIRCUIT_STATE,
  ERRORS_TOTAL,
  OPERATION_SECONDS,
  STORAGE_UP,
  SYSTEM_CATEGORY,
  currentCategory,
} from './metrics';

/**
 * Circuit breaker, timeouts and health monitoring per storage (port of P1's `resilience.py`).
 * Goal: a storage that is down fails fast and never blocks the other categories.
 *
 * Circuit breaker (one per storage)
 *   CLOSED --(`failureThreshold` consecutive failures, default 5)--> OPEN
 *   OPEN: every call throws `CircuitOpenError` (a `StorageUnavailable`) at once, without I/O.
 *   OPEN --(`resetTimeoutMs` elapsed, default 10 s; or a passing health probe)--> HALF_OPEN
 *   HALF_OPEN: exactly one trial call goes through; others are rejected while it runs.
 *   trial succeeds --> CLOSED; trial fails --> OPEN (timer restarts).
 *   `ObjectNotFound` and `IntegrityError` prove the storage answered: they count as success.
 *   Errors of the caller's own input stream and caller aborts do not count at all.
 *   A rejected `putStream` has not read a single chunk, so the same iterable can be handed to the
 *   policy's fallback storage. After any other failure the input is partly consumed.
 *
 * Timeouts
 *   put/get use an inactivity timeout (`idleTimeoutMs`, default 30 s), not a total one: for put
 *   the clock is paused while the adapter waits for the caller's next chunk; for get it covers the
 *   wait for each chunk from the storage and is paused while the caller processes a chunk. delete
 *   has a total timeout (`opTimeoutMs`, 10 s), health a short one (`healthTimeoutMs`, 2 s). On a
 *   timeout the adapter's signal is aborted so it drops the connection.
 *
 * Health monitor
 *   `HealthMonitor` polls every storage every `intervalMs` (5 s), sets `filegrid_storage_up`, opens
 *   the breaker after `tripAfter` (2) consecutive failed probes (and keeps it open while they keep
 *   failing); a passing probe moves an OPEN breaker to HALF_OPEN so the next call can close it.
 */

export type StorageLogger = Pick<Logger, 'warn' | 'error' | 'info'>;

export const BreakerState = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 } as const;
export type BreakerState = (typeof BreakerState)[keyof typeof BreakerState];
export type BreakerStateName = 'closed' | 'half_open' | 'open';

const STATE_NAMES: Record<BreakerState, BreakerStateName> = {
  0: 'closed',
  1: 'half_open',
  2: 'open',
};

export function breakerStateName(state: BreakerState): BreakerStateName {
  return STATE_NAMES[state];
}

/** Rejected without trying: the storage's circuit breaker is open. */
export class CircuitOpenError extends StorageUnavailable {}

/** The storage made no progress for `idleTimeoutMs`. */
export class IdleTimeoutError extends StorageUnavailable {}

function formatSeconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  /** Milliseconds, monotonic. */
  clock?: () => number;
  onStateChange?: (name: StorageName, from: BreakerState, to: BreakerState) => void;
  logger?: StorageLogger;
}

/** Consecutive-failure circuit breaker with a single-trial half-open state. */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  private readonly clock: () => number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  private readonly logger?: StorageLogger;
  private current: BreakerState = BreakerState.CLOSED;
  private failureCount = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: StorageName,
    options: CircuitBreakerOptions = {},
  ) {
    const threshold = options.failureThreshold ?? 5;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError('failureThreshold must be >= 1');
    }
    this.failureThreshold = threshold;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10_000;
    this.clock = options.clock ?? (() => performance.now());
    this.onStateChange = options.onStateChange;
    this.logger = options.logger;
    CIRCUIT_STATE.labels(name).set(this.current);
  }

  get state(): BreakerState {
    return this.current;
  }

  get stateName(): BreakerStateName {
    return breakerStateName(this.current);
  }

  get failures(): number {
    return this.failureCount;
  }

  private set(state: BreakerState): void {
    const previous = this.current;
    this.current = state;
    if (previous === state) return;
    CIRCUIT_STATE.labels(this.name).set(state);
    this.logger?.warn(
      { storage: this.name, from: breakerStateName(previous), to: breakerStateName(state) },
      'storage circuit state changed',
    );
    this.onStateChange?.(this.name, previous, state);
  }

  /** Admit a call or throw `CircuitOpenError`. Returns true if the call is the half-open trial. */
  beforeCall(): boolean {
    if (this.current === BreakerState.OPEN) {
      if (this.clock() - this.openedAt < this.resetTimeoutMs) {
        throw new CircuitOpenError(`${this.name}: circuit open`);
      }
      this.set(BreakerState.HALF_OPEN);
    }
    if (this.current === BreakerState.HALF_OPEN) {
      if (this.trialInFlight) {
        throw new CircuitOpenError(`${this.name}: circuit half-open, trial call in progress`);
      }
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(trial = false): void {
    if (trial) this.trialInFlight = false;
    // A call admitted before the breaker opened proves little; wait for the trial.
    if (this.current === BreakerState.OPEN && !trial) return;
    this.failureCount = 0;
    this.set(BreakerState.CLOSED);
  }

  recordFailure(trial = false): void {
    if (trial) this.trialInFlight = false;
    if (this.current === BreakerState.HALF_OPEN || trial) {
      this.open();
      return;
    }
    if (this.current === BreakerState.CLOSED) {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) this.open();
    }
  }

  /** The call ended without telling anything about the storage (aborted, caller's input failed). */
  recordIgnored(trial = false): void {
    if (trial) this.trialInFlight = false;
  }

  /** Open now (or keep open and restart the timer): used when health probes fail. */
  trip(): void {
    this.open();
  }

  /** OPEN -> HALF_OPEN now (a health probe passed): the next call is the trial. */
  allowTrial(): void {
    if (this.current === BreakerState.OPEN) this.set(BreakerState.HALF_OPEN);
  }

  private open(): void {
    this.openedAt = this.clock();
    this.failureCount = 0;
    this.set(BreakerState.OPEN);
  }
}

/** The `error_type` label for a failed operation. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof CircuitOpenError) return 'CircuitOpen';
  if (error instanceof IdleTimeoutError) return 'IdleTimeout';
  if (error instanceof ObjectNotFound || error instanceof IntegrityError) return error.name;
  if (error instanceof InvalidKey) return error.name;
  if (error instanceof StorageError && error.cause !== undefined) return errorKind(error.cause);
  if (error instanceof Error && error.name === 'TimeoutError') return 'Timeout';
  return errorKind(error);
}

function countsAsSuccess(error: unknown): boolean {
  return error instanceof ObjectNotFound || error instanceof IntegrityError;
}

/** Records one operation's metrics: duration, outcome, errors, bytes. */
class OperationRecorder {
  private readonly startMs = performance.now();

  constructor(
    readonly storage: StorageName,
    readonly operation: 'put' | 'get' | 'delete' | 'health',
    readonly category: string,
  ) {}

  elapsedMs(): number {
    return elapsedMs(this.startMs);
  }

  private observe(outcome: 'ok' | 'error' | 'rejected'): void {
    OPERATION_SECONDS.labels(this.storage, this.operation, this.category, outcome).observe(
      this.elapsedMs() / 1000,
    );
  }

  ok(): void {
    this.observe('ok');
  }

  error(error: unknown, errorType?: string): void {
    this.observe(error instanceof CircuitOpenError ? 'rejected' : 'error');
    ERRORS_TOTAL.labels(
      this.storage,
      this.operation,
      this.category,
      errorType ?? errorTypeOf(error),
    ).inc();
  }

  addBytes(count: number): void {
    BYTES_TOTAL.labels(this.storage, this.operation, this.category).inc(count);
  }
}

/** An inactivity deadline that can be paused and re-armed. */
class IdleDeadline {
  expired = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly ms: number,
    private readonly onExpire: () => void,
  ) {}

  arm(): void {
    if (this.expired || this.stopped) return;
    if (this.timer) {
      this.timer.refresh();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expired = true;
      this.onExpire();
    }, this.ms);
  }

  pause(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }
}

/** Internal marker: the caller's input stream threw (so the adapter cannot blame itself). */
class SourceFailure extends Error {
  constructor(readonly original: unknown) {
    super('the caller input stream failed', { cause: original });
    this.name = 'SourceFailure';
  }
}

/**
 * Wraps the caller's chunks for put: pauses the idle deadline while waiting for the caller,
 * re-arms it when a chunk is handed to the adapter, counts bytes and remembers caller errors.
 */
class GuardedSource implements AsyncIterable<Uint8Array> {
  failed = false;
  error: unknown = undefined;

  constructor(
    private readonly source: AsyncIterable<Uint8Array>,
    private readonly op: OperationRecorder,
    private readonly idle: IdleDeadline,
    private readonly signal: AbortSignal,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
    const iterator = this.source[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      while (true) {
        throwIfAborted(this.signal);
        this.idle.pause();
        let step: IteratorResult<Uint8Array>;
        try {
          step = await iterator.next();
        } catch (error) {
          exhausted = true;
          this.failed = true;
          this.error = error;
          throw new SourceFailure(error);
        } finally {
          this.idle.arm();
        }
        if (step.done) {
          exhausted = true;
          return;
        }
        if (step.value.length > 0) this.op.addBytes(step.value.length);
        yield step.value;
      }
    } finally {
      if (!exhausted) await closeQuietly(iterator);
    }
  }
}

export interface ResilientStorageOptions {
  breaker?: CircuitBreaker;
  idleTimeoutMs?: number;
  opTimeoutMs?: number;
  healthTimeoutMs?: number;
  logger?: StorageLogger;
}

/** Wraps an adapter with a circuit breaker, timeouts and metrics; same interface as the adapter. */
export class ResilientStorage implements StorageAdapter {
  readonly name: StorageName;
  readonly breaker: CircuitBreaker;
  readonly idleTimeoutMs: number;
  readonly opTimeoutMs: number;
  readonly healthTimeoutMs: number;
  lastHealth: HealthStatus | null = null;
  lastHealthAt: Date | null = null;
  private healthFailures = 0;

  constructor(
    readonly adapter: StorageAdapter,
    options: ResilientStorageOptions = {},
  ) {
    this.name = adapter.name;
    this.breaker = options.breaker ?? new CircuitBreaker(adapter.name, { logger: options.logger });
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.opTimeoutMs = options.opTimeoutMs ?? 10_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  private admit(op: OperationRecorder): boolean {
    try {
      return this.breaker.beforeCall();
    } catch (error) {
      op.error(error);
      throw error;
    }
  }

  private settle(op: OperationRecorder, trial: boolean, error: unknown, sourceError = false): void {
    if (error === undefined) {
      this.breaker.recordSuccess(trial);
      op.ok();
    } else if (sourceError) {
      this.breaker.recordIgnored(trial);
      op.error(error, 'SourceError');
    } else if (countsAsSuccess(error)) {
      this.breaker.recordSuccess(trial);
      op.error(error);
    } else {
      this.breaker.recordFailure(trial);
      op.error(error);
    }
  }

  async putStream(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StorageCallOptions = {},
  ): Promise<PutResult> {
    validateKey(key);
    const op = new OperationRecorder(this.name, 'put', currentCategory());
    const trial = this.admit(op);
    const controller = new AbortController();
    const caller = options.signal;
    const unlink = onAbort(caller, () => controller.abort(abortReason(caller as AbortSignal)));
    let idleError: IdleTimeoutError | undefined;
    const idle = new IdleDeadline(this.idleTimeoutMs, () => {
      idleError = new IdleTimeoutError(
        `${this.name}: no progress for ${formatSeconds(this.idleTimeoutMs)}s during put`,
      );
      controller.abort(idleError);
    });
    const guard = new GuardedSource(chunks, op, idle, controller.signal);
    try {
      idle.arm();
      const work = this.adapter.putStream(key, guard, { signal: controller.signal });
      const result = await abortable(work, controller.signal);
      idle.stop();
      this.settle(op, trial, undefined);
      return result;
    } catch (error) {
      idle.stop();
      if (caller?.aborted) {
        this.breaker.recordIgnored(trial);
        throw error;
      }
      if (guard.failed) {
        // The caller's input failed (e.g. client disconnected): not the storage's fault.
        this.settle(op, trial, guard.error, true);
        throw guard.error;
      }
      if (idleError) {
        this.settle(op, trial, idleError);
        throw idleError;
      }
      this.settle(op, trial, error);
      throw error;
    } finally {
      unlink();
    }
  }

  getStream(
    key: string,
    options: StorageCallOptions = {},
  ): AsyncGenerator<Buffer, void, undefined> {
    validateKey(key);
    // The category is captured now, not when the caller starts iterating.
    return this.read(key, currentCategory(), options.signal);
  }

  private async *read(
    key: string,
    category: string,
    caller: AbortSignal | undefined,
  ): AsyncGenerator<Buffer, void, undefined> {
    const op = new OperationRecorder(this.name, 'get', category);
    let trial = this.admit(op);
    const controller = new AbortController();
    const unlink = onAbort(caller, () => controller.abort(abortReason(caller as AbortSignal)));
    let iterator: AsyncIterator<Buffer> | undefined;
    let stepPending = false;
    let received = 0;
    let outcome: 'open' | 'done' | 'failed' = 'open';
    try {
      iterator = this.adapter.getStream(key, { signal: controller.signal })[Symbol.asyncIterator]();
      while (true) {
        stepPending = true;
        const step = await this.nextWithIdleTimeout(iterator, controller);
        stepPending = false;
        if (step.done) break;
        const chunk = step.value;
        if (chunk.length > 0) {
          received += chunk.length;
          op.addBytes(chunk.length);
          if (trial) {
            // The storage answered: close the breaker now, so a long half-open trial transfer
            // (a big download) does not keep rejecting every other call until it ends.
            this.breaker.recordSuccess(true);
            trial = false;
          }
        }
        yield chunk;
      }
      outcome = 'done';
    } catch (error) {
      outcome = 'failed';
      if (caller?.aborted) this.breaker.recordIgnored(trial);
      else this.settle(op, trial, error);
      throw error;
    } finally {
      unlink();
      if (outcome === 'open') {
        // The consumer stopped early: not the storage's fault. Data flowed => the storage works.
        if (received > 0) this.breaker.recordSuccess(trial);
        else this.breaker.recordIgnored(trial);
      }
      if (stepPending) {
        // A step is still running (timed out): close in the background once it settles.
        void closeQuietly(iterator);
      } else {
        await closeQuietly(iterator);
      }
    }
    this.settle(op, trial, undefined);
  }

  private async nextWithIdleTimeout(
    iterator: AsyncIterator<Buffer>,
    controller: AbortController,
  ): Promise<IteratorResult<Buffer>> {
    const timer = setTimeout(() => {
      controller.abort(
        new IdleTimeoutError(
          `${this.name}: no data for ${formatSeconds(this.idleTimeoutMs)}s during get`,
        ),
      );
    }, this.idleTimeoutMs);
    try {
      return await abortable(iterator.next(), controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async delete(key: string, options: StorageCallOptions = {}): Promise<void> {
    validateKey(key);
    const op = new OperationRecorder(this.name, 'delete', currentCategory());
    const trial = this.admit(op);
    const controller = new AbortController();
    const caller = options.signal;
    const unlink = onAbort(caller, () => controller.abort(abortReason(caller as AbortSignal)));
    let timedOut: StorageUnavailable | undefined;
    const timer = setTimeout(() => {
      timedOut = new StorageUnavailable(
        `${this.name}: delete timed out after ${formatSeconds(this.opTimeoutMs)}s`,
        { cause: timeoutError('delete timed out') },
      );
      controller.abort(timedOut);
    }, this.opTimeoutMs);
    try {
      await abortable(this.adapter.delete(key, { signal: controller.signal }), controller.signal);
    } catch (error) {
      if (caller?.aborted) {
        this.breaker.recordIgnored(trial);
        throw error;
      }
      const failure = timedOut ?? error;
      this.settle(op, trial, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      unlink();
    }
    this.settle(op, trial, undefined);
  }

  /** Probe the storage directly (bypasses the breaker so an open breaker can see recovery). */
  async health(options: StorageCallOptions = {}): Promise<HealthStatus> {
    const op = new OperationRecorder(this.name, 'health', SYSTEM_CATEGORY);
    const controller = new AbortController();
    const caller = options.signal;
    const unlink = onAbort(caller, () => controller.abort(abortReason(caller as AbortSignal)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError('health probe timed out'));
    }, this.healthTimeoutMs);
    let status: HealthStatus;
    try {
      status = await abortable(
        this.adapter.health({ signal: controller.signal }),
        controller.signal,
      );
    } catch (error) {
      status = timedOut
        ? {
            ok: false,
            latencyMs: this.healthTimeoutMs,
            detail: `health probe timed out after ${formatSeconds(this.healthTimeoutMs)}s`,
          }
        : {
            ok: false,
            latencyMs: op.elapsedMs(),
            detail: `health probe failed: ${errorKind(error)}`,
          };
    } finally {
      clearTimeout(timer);
      unlink();
    }
    if (status.ok) op.ok();
    else op.error(new StorageUnavailable(status.detail), 'HealthCheckFailed');
    STORAGE_UP.labels(this.name).set(status.ok ? 1 : 0);
    this.lastHealth = status;
    this.lastHealthAt = new Date();
    return status;
  }

  /** Run one probe and feed the result to the breaker (used by `HealthMonitor`). */
  async checkHealth(tripAfter = 2): Promise<HealthStatus> {
    const status = await this.health();
    if (status.ok) {
      this.healthFailures = 0;
      this.breaker.allowTrial();
    } else {
      this.healthFailures += 1;
      if (this.healthFailures >= tripAfter) this.breaker.trip();
    }
    return status;
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}

export interface HealthMonitorOptions {
  intervalMs?: number;
  tripAfter?: number;
  logger?: StorageLogger;
}

/** Background poller of every storage's health; see the module comment. */
export class HealthMonitor {
  readonly storages: readonly ResilientStorage[];
  readonly intervalMs: number;
  readonly tripAfter: number;
  private readonly logger?: StorageLogger;
  private active = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(storages: Iterable<ResilientStorage>, options: HealthMonitorOptions = {}) {
    this.storages = [...storages];
    this.intervalMs = options.intervalMs ?? 5000;
    this.tripAfter = options.tripAfter ?? 2;
    this.logger = options.logger;
  }

  async checkOnce(): Promise<Partial<Record<StorageName, HealthStatus>>> {
    const results = await Promise.all(this.storages.map((s) => s.checkHealth(this.tripAfter)));
    const out: Partial<Record<StorageName, HealthStatus>> = {};
    this.storages.forEach((storage, index) => {
      out[storage.name] = results[index];
    });
    return out;
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.tick();
  }

  private tick(): void {
    if (!this.active) return;
    this.inFlight = this.checkOnce().then(
      () => undefined,
      (error: unknown) => {
        // keep monitoring whatever happens
        this.logger?.error({ err: error }, 'storage health monitor iteration failed');
      },
    );
    void this.inFlight.then(() => {
      this.inFlight = undefined;
      if (!this.active) return;
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
      this.timer.unref();
    });
  }

  async stop(): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
