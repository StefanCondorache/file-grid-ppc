import type { Clock } from './types';

/** Progress cadence of upload-engine.md §14. Pure helpers, no React. */
export const SPEED_ALPHA = 0.2;
export const ETA_ALPHA = 0.3;
/** Minimum spacing of two speed samples. */
export const SAMPLE_MS = 500;
/** Speed and ETA stay hidden until this much data has been measured. */
export const ETA_HIDDEN_MS = 3000;
/** The UI shows "mai mult de 24 h" at the cap. */
export const ETA_CAP_S = 24 * 60 * 60;
/** Progress snapshots reach the store at most every 250 ms (4 Hz); transitions go at once. */
export const SNAPSHOT_MS = 250;

/** Exponential moving average of the throughput, alpha 0.2 (time constant about 2.5 s at 2 samples/s). */
export function speedEma(prev: number | null, instant: number): number {
  return prev === null ? instant : SPEED_ALPHA * instant + (1 - SPEED_ALPHA) * prev;
}

export interface SpeedReading {
  speedBps: number | null;
  etaS: number | null;
}

/**
 * Speed (EMA) and ETA (a second EMA, alpha 0.3) of one upload. Both are null for the first 3 s of data and again
 * after `reset()` (pause or connection lost), so a stale speed is never shown.
 */
export function createSpeedMeter() {
  let firstAt: number | null = null;
  let lastAt = 0;
  let lastBytes = 0;
  let speed: number | null = null;
  let eta: number | null = null;

  return {
    sample(now: number, doneBytes: number, totalBytes: number): void {
      if (firstAt === null) {
        firstAt = now;
        lastAt = now;
        lastBytes = doneBytes;
        return;
      }
      const dt = now - lastAt;
      if (dt < SAMPLE_MS) return;
      speed = speedEma(speed, Math.max(0, doneBytes - lastBytes) / (dt / 1000));
      lastAt = now;
      lastBytes = doneBytes;
      if (now - firstAt < ETA_HIDDEN_MS) return;
      const raw = speed > 0 ? Math.max(0, totalBytes - doneBytes) / speed : ETA_CAP_S;
      eta = eta === null ? raw : ETA_ALPHA * raw + (1 - ETA_ALPHA) * eta;
    },
    read(now: number): SpeedReading {
      if (firstAt === null || now - firstAt < ETA_HIDDEN_MS) return { speedBps: null, etaS: null };
      return { speedBps: speed, etaS: eta === null ? null : Math.min(ETA_CAP_S, Math.ceil(eta)) };
    },
    reset(): void {
      firstAt = null;
      speed = null;
      eta = null;
    },
  };
}

export type SpeedMeter = ReturnType<typeof createSpeedMeter>;

/**
 * Coalesces store writes: `schedule()` (progress) flushes at most once per `intervalMs`; `now()` (a transition)
 * flushes at once and folds any pending progress flush into it.
 */
export function createCoalescer(clock: Clock, flush: () => void, intervalMs = SNAPSHOT_MS) {
  let timer: unknown = null;
  let last = -Infinity;

  function cancel(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function run(): void {
    timer = null;
    last = clock.now();
    flush();
  }

  return {
    schedule(): void {
      if (timer !== null) return;
      timer = clock.setTimeout(run, Math.max(0, last + intervalMs - clock.now()));
    },
    now(): void {
      cancel();
      run();
    },
    dispose: cancel,
  };
}
