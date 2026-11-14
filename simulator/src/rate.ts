// Token bucket: tokens refill continuously at `ratePerS`; the bucket holds at most `burstS` seconds of tokens,
// so a pause (backpressure, stopped mode) never turns into a huge burst afterwards.

export type Clock = () => number;

export interface TokenBucketOptions {
  readonly ratePerS: number;
  readonly now: Clock;
  readonly burstS?: number;
}

const DEFAULT_BURST_S = 1;

export class TokenBucket {
  readonly #now: Clock;
  readonly #burstS: number;
  #rate: number;
  #tokens = 0;
  #last: number;

  constructor(options: TokenBucketOptions) {
    this.#now = options.now;
    this.#burstS = options.burstS ?? DEFAULT_BURST_S;
    this.#rate = Math.max(0, options.ratePerS);
    this.#last = this.#now();
  }

  get ratePerS(): number {
    return this.#rate;
  }

  #capacity(): number {
    return Math.max(1, this.#rate * this.#burstS);
  }

  #refill(): void {
    const now = this.#now();
    const elapsedS = Math.max(0, now - this.#last) / 1000;
    this.#last = now;
    this.#tokens = Math.min(this.#capacity(), this.#tokens + elapsedS * this.#rate);
  }

  /** Changes the rate; tokens earned so far at the old rate are kept (up to the new capacity). */
  setRate(ratePerS: number): void {
    const next = Math.max(0, ratePerS);
    if (next === this.#rate) return;
    this.#refill();
    this.#rate = next;
    this.#tokens = next === 0 ? 0 : Math.min(this.#tokens, this.#capacity());
  }

  /** Takes up to `max` whole tokens and returns how many were taken. */
  take(max: number): number {
    this.#refill();
    const n = Math.max(0, Math.min(Math.floor(this.#tokens), Math.floor(max)));
    this.#tokens -= n;
    return n;
  }
}
