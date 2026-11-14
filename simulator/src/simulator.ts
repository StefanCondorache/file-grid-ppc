// Wires the pieces together: a generator loop (token bucket -> meter fleet -> bounded queue), the sender,
// the mode controller, the metrics and a periodic summary log line.

import { Controller } from './control.ts';
import type { ControlSnapshot, ControlUpdate } from './control.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import { createSimMetrics } from './metrics.ts';
import type { Mode, SimMetrics } from './metrics.ts';
import { BoundedQueue } from './queue.ts';
import { TokenBucket } from './rate.ts';
import type { Clock } from './rate.ts';
import { MeterFleet } from './readings.ts';
import type { Reading, Rng } from './readings.ts';
import { Sender } from './sender.ts';
import type { SenderOptions } from './sender.ts';

const DEFAULT_TICK_MS = 50;
const DEFAULT_SUMMARY_INTERVAL_MS = 30_000;
const BACKPRESSURE_LOG_INTERVAL_MS = 30_000;

export interface ControlStatus {
  readonly mode: Mode;
  readonly ratePerS: number;
  readonly normalRatePerS: number;
  readonly peakRatePerS: number;
  readonly queueDepth: number;
  readonly stormEndsAt: string | null;
  /** Unique readings sent / acknowledged since start: the backend derives "lost" from them. */
  readonly sentUnique: number;
  readonly ackedUnique: number;
}

export interface SimulatorOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly now?: Clock;
  readonly rng?: Rng;
  /** First sequence number of every meter (default: startup time in ms, unique across restarts). */
  readonly sequenceBase?: number;
  readonly tickMs?: number;
  readonly summaryIntervalMs?: number;
  /** Test hooks for the sender (fake fetch, short backoff, ...). */
  readonly sender?: Partial<Pick<SenderOptions, 'fetch' | 'sleep' | 'requestTimeoutMs' | 'backoffBaseMs' | 'backoffCapMs' | 'authPauseMs'>>;
}

export class Simulator {
  readonly controller: Controller;
  readonly queue: BoundedQueue<Reading>;
  readonly fleet: MeterFleet;
  readonly bucket: TokenBucket;
  readonly sender: Sender;
  readonly metrics: SimMetrics;
  readonly #log: Logger;
  readonly #now: Clock;
  readonly #tickMs: number;
  readonly #summaryIntervalMs: number;
  #backpressure = false;
  #lastBackpressureLog = Number.NEGATIVE_INFINITY;
  #generating = false;
  #tickTimer: NodeJS.Timeout | undefined;
  #summaryTimer: NodeJS.Timeout | undefined;

  constructor(options: SimulatorOptions) {
    const { config, log } = options;
    this.#log = log;
    this.#now = options.now ?? Date.now;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#summaryIntervalMs = options.summaryIntervalMs ?? DEFAULT_SUMMARY_INTERVAL_MS;
    this.controller = new Controller({
      normalRatePerS: config.meterRate,
      stormFactor: config.stormFactor,
      maxRatePerS: config.maxRate,
      now: this.#now,
      onChange: (snapshot, reason) => this.#onModeChange(snapshot, reason),
    });
    this.queue = new BoundedQueue<Reading>(config.maxQueue);
    this.fleet = new MeterFleet({
      meterCount: config.meterCount,
      sequenceBase: options.sequenceBase ?? this.#now(),
      ...(options.rng ? { rng: options.rng } : {}),
    });
    this.bucket = new TokenBucket({ ratePerS: this.controller.ratePerS(), now: this.#now });
    this.metrics = createSimMetrics({
      ratePerS: () => this.controller.ratePerS(),
      queueDepth: () => this.queue.depth,
      mode: () => this.controller.mode,
      backpressure: () => this.#backpressure,
    });
    this.sender = new Sender({
      backendUrl: config.backendUrl,
      apiKey: config.apiKey,
      batchMax: config.batchMax,
      flushIntervalMs: config.flushIntervalMs,
      duplicateRatio: config.duplicateRatio,
      queue: this.queue,
      metrics: this.metrics,
      log,
      now: this.#now,
      ...(options.rng ? { rng: options.rng } : {}),
      ...options.sender,
    });
  }

  get backpressure(): boolean {
    return this.#backpressure;
  }

  start(): void {
    if (this.#generating) return;
    this.#generating = true;
    this.sender.start();
    this.#tickTimer = setInterval(() => this.tick(), this.#tickMs);
    this.#summaryTimer = setInterval(() => this.logSummary(), this.#summaryIntervalMs);
    this.#log.info('simulator started', { ...this.status(), meters: this.fleet.size });
  }

  /** One generator step: create as many readings as the rate allows and the queue has room for. */
  tick(): number {
    const rate = this.controller.ratePerS();
    this.bucket.setRate(rate);
    if (rate === 0) return 0;
    const room = this.queue.free;
    const n = room > 0 ? this.bucket.take(room) : 0;
    const origin = this.controller.origin();
    const now = this.#now();
    for (let i = 0; i < n; i += 1) this.queue.push(this.fleet.next(now, origin)); // n <= room: always accepted
    this.#setBackpressure(this.queue.free === 0);
    if (n > 0) this.sender.notify();
    return n;
  }

  status(): ControlStatus {
    const s = this.controller.snapshot();
    return {
      mode: s.mode,
      ratePerS: s.ratePerS,
      normalRatePerS: s.normalRatePerS,
      peakRatePerS: s.peakRatePerS,
      queueDepth: this.queue.depth,
      stormEndsAt: s.endsAt === null ? null : new Date(s.endsAt).toISOString(),
      sentUnique: this.metrics.readingsSent.total(),
      ackedUnique: this.metrics.readingsAcked.total(),
    };
  }

  applyControl(update: ControlUpdate): ControlStatus {
    this.controller.apply(update);
    this.bucket.setRate(this.controller.ratePerS());
    return this.status();
  }

  renderMetrics(): string {
    return this.metrics.registry.render();
  }

  logSummary(): void {
    const m = this.metrics;
    this.#log.info('simulator summary', {
      mode: this.controller.mode,
      ratePerS: this.controller.ratePerS(),
      sent: m.readingsSent.total(),
      acked: m.readingsAcked.total(),
      rejected: m.readingsRejected.total(),
      retries: m.retries.total(),
      duplicatesSent: m.duplicatesSent.total(),
      queueDepth: this.queue.depth,
      inFlightRequests: this.sender.activeRequests,
      backpressure: this.#backpressure,
    });
  }

  /** Stops generating, flushes for up to `drainMs`, then stops the sender. Returns true if nothing was left. */
  async shutdown(drainMs: number): Promise<boolean> {
    this.#stopTimers();
    this.#log.info('simulator stopping, flushing queue', { queueDepth: this.queue.depth, drainMs });
    const drained = await this.sender.drain(drainMs);
    this.sender.stop();
    this.logSummary();
    if (!drained) this.#log.warn('simulator stopped with unacknowledged readings', { queueDepth: this.queue.depth });
    return drained;
  }

  /** Stops everything at once (tests). */
  stop(): void {
    this.#stopTimers();
    this.sender.stop();
  }

  #stopTimers(): void {
    this.#generating = false;
    if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
    if (this.#summaryTimer !== undefined) clearInterval(this.#summaryTimer);
    this.#tickTimer = undefined;
    this.#summaryTimer = undefined;
  }

  #setBackpressure(full: boolean): void {
    const entering = full && !this.#backpressure;
    this.#backpressure = full;
    if (!entering) return;
    const now = this.#now();
    if (now - this.#lastBackpressureLog < BACKPRESSURE_LOG_INTERVAL_MS) return; // the summary line still shows it
    this.#lastBackpressureLog = now;
    this.#log.warn('queue full, pausing reading generation until the backend catches up', {
      queueDepth: this.queue.depth,
    });
  }

  #onModeChange(snapshot: ControlSnapshot, reason: 'update' | 'expired'): void {
    this.#log.info(reason === 'expired' ? 'timed mode ended, back to normal' : 'simulator mode changed', {
      mode: snapshot.mode,
      ratePerS: snapshot.ratePerS,
      endsAt: snapshot.endsAt === null ? null : new Date(snapshot.endsAt).toISOString(),
    });
  }
}
