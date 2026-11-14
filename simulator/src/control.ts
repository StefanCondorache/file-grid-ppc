// Generation mode state machine: normal, peak (storm, METER_RATE x STORM_FACTOR), custom (explicit rate)
// and stopped. A timed mode (durationS) returns to normal on its own.

import { MODES } from './metrics.ts';
import type { Mode } from './metrics.ts';
import type { Clock } from './rate.ts';
import type { Origin } from './readings.ts';

export const MAX_DURATION_S = 3600;

export interface ControlUpdate {
  readonly mode: Mode;
  readonly ratePerS?: number;
  readonly durationS?: number;
}

export type ParseResult = { readonly ok: true; readonly value: ControlUpdate } | { readonly ok: false; readonly message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined | string {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a finite number`;
  return value;
}

/** Validates a PUT /control body. Unknown fields are ignored. */
export function parseControlUpdate(body: unknown): ParseResult {
  if (!isPlainObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const mode = MODES.find((m) => m === body.mode);
  if (mode === undefined) return { ok: false, message: `mode must be one of ${MODES.join(', ')}` };

  const ratePerS = optionalNumber(body, 'ratePerS');
  if (typeof ratePerS === 'string') return { ok: false, message: ratePerS };
  if (ratePerS !== undefined && ratePerS < 0) return { ok: false, message: 'ratePerS must be >= 0' };
  if (mode === 'custom' && ratePerS === undefined) return { ok: false, message: 'ratePerS is required for mode custom' };

  const durationS = optionalNumber(body, 'durationS');
  if (typeof durationS === 'string') return { ok: false, message: durationS };
  if (durationS !== undefined && (durationS <= 0 || durationS > MAX_DURATION_S)) {
    return { ok: false, message: `durationS must be > 0 and <= ${MAX_DURATION_S}` };
  }

  return {
    ok: true,
    value: {
      mode,
      ...(mode === 'custom' && ratePerS !== undefined ? { ratePerS } : {}),
      ...(mode !== 'normal' && durationS !== undefined ? { durationS } : {}),
    },
  };
}

export interface ControlSnapshot {
  readonly mode: Mode;
  readonly ratePerS: number;
  readonly normalRatePerS: number;
  readonly peakRatePerS: number;
  readonly endsAt: number | null;
}

export interface ControllerOptions {
  readonly normalRatePerS: number;
  readonly stormFactor: number;
  readonly maxRatePerS: number;
  readonly now: Clock;
  readonly onChange?: (snapshot: ControlSnapshot, reason: 'update' | 'expired') => void;
}

export class Controller {
  readonly #normalRate: number;
  readonly #peakRate: number;
  readonly #maxRate: number;
  readonly #now: Clock;
  readonly #onChange: ControllerOptions['onChange'];
  #mode: Mode = 'normal';
  #customRate = 0;
  #endsAt: number | null = null;

  constructor(options: ControllerOptions) {
    this.#maxRate = options.maxRatePerS;
    this.#normalRate = Math.min(options.normalRatePerS, this.#maxRate);
    this.#peakRate = Math.min(options.normalRatePerS * options.stormFactor, this.#maxRate);
    this.#now = options.now;
    this.#onChange = options.onChange;
  }

  /** Returns to normal once a timed mode has run out. Called on every generator tick. */
  tick(): void {
    if (this.#endsAt === null || this.#now() < this.#endsAt) return;
    this.#mode = 'normal';
    this.#endsAt = null;
    this.#onChange?.(this.snapshot(), 'expired');
  }

  apply(update: ControlUpdate): ControlSnapshot {
    this.#mode = update.mode;
    this.#customRate = update.mode === 'custom' ? Math.min(update.ratePerS ?? 0, this.#maxRate) : 0;
    this.#endsAt =
      update.mode !== 'normal' && update.durationS !== undefined ? this.#now() + update.durationS * 1000 : null;
    const snapshot = this.snapshot();
    this.#onChange?.(snapshot, 'update');
    return snapshot;
  }

  get mode(): Mode {
    this.tick();
    return this.#mode;
  }

  ratePerS(): number {
    this.tick();
    switch (this.#mode) {
      case 'normal':
        return this.#normalRate;
      case 'peak':
        return this.#peakRate;
      case 'custom':
        return this.#customRate;
      case 'stopped':
        return 0;
    }
  }

  origin(): Origin {
    return this.mode === 'peak' ? 'storm' : 'simulator';
  }

  snapshot(): ControlSnapshot {
    this.tick();
    return {
      mode: this.#mode,
      ratePerS: this.ratePerS(),
      normalRatePerS: this.#normalRate,
      peakRatePerS: this.#peakRate,
      endsAt: this.#endsAt,
    };
  }
}
