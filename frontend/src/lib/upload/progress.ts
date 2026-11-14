import type { Clock } from './types';

const ALPHA = 0.2;
const SAMPLE_MS = 500;
const WARMUP_MS = 3000;

/** Exponential moving average of throughput (upload-engine.md §14): time constant ≈ 2.5 s at 2 samples/s. */
export function speedEma(prev: number | null, instant: number, alpha = ALPHA): number {
  return prev === null ? instant : alpha * instant + (1 - alpha) * prev;
}

/** Speed and ETA for one upload; both stay hidden for the first 3 s after a (re)start so a stale guess never shows. */
export function createRateTracker(clock: Clock) {
  let startAt = clock.now();
  let lastAt = startAt;
  let lastBytes = 0;
  let ema: number | null = null;

  const speed = (): number | null => (clock.now() - startAt < WARMUP_MS ? null : ema);

  return {
    reset(bytes: number): void {
      startAt = clock.now();
      lastAt = startAt;
      lastBytes = bytes;
      ema = null;
    },
    sample(bytes: number): void {
      const now = clock.now();
      if (now - lastAt < SAMPLE_MS) return;
      ema = speedEma(ema, Math.max(0, bytes - lastBytes) / ((now - lastAt) / 1000));
      lastAt = now;
      lastBytes = bytes;
    },
    speed,
    eta(remainingBytes: number): number | null {
      const s = speed();
      return s !== null && s > 0 ? remainingBytes / s : null;
    },
  };
}

export type RateTracker = ReturnType<typeof createRateTracker>;

/** Coalesces progress publishes to at most one per `intervalMs` (4 Hz); `flush` publishes a transition at once. */
export function createThrottle(fn: () => void, intervalMs: number, clock: Clock) {
  let last = -Infinity;
  let timer: unknown = null;
  const fire = () => {
    timer = null;
    last = clock.now();
    fn();
  };
  return {
    schedule(): void {
      if (timer !== null) return;
      const wait = intervalMs - (clock.now() - last);
      if (wait <= 0) fire();
      else timer = clock.setTimeout(fire, wait);
    },
    flush(): void {
      if (timer !== null) clock.clearTimeout(timer);
      fire();
    },
    cancel(): void {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
