// Bounded FIFO of readings that are not yet acknowledged. Readings taken by the sender stay counted
// ("in flight") until their batch is settled, so the bound covers every unacked reading held in memory.
// A full queue refuses new items (push returns false); the generator pauses instead of dropping.

const COMPACT_MIN_HEAD = 1024;

export class BoundedQueue<T> {
  readonly capacity: number;
  #items: T[] = [];
  #head = 0;
  #inFlight = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('queue capacity must be a positive integer');
    this.capacity = capacity;
  }

  /** Items waiting to be sent. */
  get queued(): number {
    return this.#items.length - this.#head;
  }

  /** Items taken by the sender and not yet settled. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Every unsettled item: waiting plus in flight. */
  get depth(): number {
    return this.queued + this.#inFlight;
  }

  get free(): number {
    return Math.max(0, this.capacity - this.depth);
  }

  push(item: T): boolean {
    if (this.free === 0) return false;
    this.#items.push(item);
    return true;
  }

  /** Removes up to `max` items from the head and marks them in flight until `settle` is called. */
  take(max: number): T[] {
    const n = Math.max(0, Math.min(Math.floor(max), this.queued));
    const out = this.#items.slice(this.#head, this.#head + n);
    this.#head += n;
    this.#inFlight += n;
    this.#compact();
    return out;
  }

  /** Releases `count` in-flight items (their batch was acknowledged or rejected). */
  settle(count: number): void {
    if (count > this.#inFlight) throw new RangeError(`cannot settle ${count} items, only ${this.#inFlight} in flight`);
    this.#inFlight -= count;
  }

  #compact(): void {
    if (this.#head < COMPACT_MIN_HEAD || this.#head * 2 < this.#items.length) return;
    this.#items = this.#items.slice(this.#head);
    this.#head = 0;
  }
}
