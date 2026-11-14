import {
  COALESCED_EVENTS,
  COALESCE_MS,
  type StreamEvent,
  type StreamEventName,
} from './events.types';

/** The part of an HTTP response an SSE client writes to. */
export interface SseTarget {
  write(chunk: string): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(): void;
}

export interface SseClientOptions {
  /** Unsent bytes allowed in the response buffer; beyond that the client is too slow and dropped. */
  readonly maxBufferedBytes: number;
  /** Next event id (process-wide, monotonic). */
  readonly nextId: () => number;
  readonly onClose: () => void;
  readonly coalesceMs?: number;
  readonly now?: () => number;
}

export const RETRY_MS = 3000;

let lastId = 0;
/** Monotonic per process and roughly ordered across replicas (microseconds since the epoch). */
export function nextEventId(): number {
  lastId = Math.max(lastId + 1, Date.now() * 1000);
  return lastId;
}

/**
 * One open event stream. Memory is bounded: at most one pending snapshot per coalesced event type,
 * and a client whose response buffer grows past `maxBufferedBytes` (it does not read) is dropped.
 */
export class SseClient {
  private readonly lastSentAt = new Map<StreamEventName, number>();
  private readonly pending = new Map<StreamEventName, StreamEvent>();
  private readonly timers = new Map<StreamEventName, NodeJS.Timeout>();
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private open = true;

  constructor(
    private readonly target: SseTarget,
    private readonly options: SseClientOptions,
  ) {
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.now = options.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.open;
  }

  start(): void {
    this.write(`retry: ${RETRY_MS}\n\n`);
  }

  send(event: StreamEvent): void {
    if (!this.open) return;
    if (!COALESCED_EVENTS.has(event.type)) {
      this.writeEvent(event);
      return;
    }
    const since = this.now() - (this.lastSentAt.get(event.type) ?? -Infinity);
    if (since >= this.coalesceMs && !this.timers.has(event.type)) {
      this.writeEvent(event);
      return;
    }
    this.pending.set(event.type, event); // the newest snapshot replaces an unsent older one
    if (this.timers.has(event.type)) return;
    const timer = setTimeout(() => this.flush(event.type), Math.max(0, this.coalesceMs - since));
    timer.unref();
    this.timers.set(event.type, timer);
  }

  /** Ends the stream; `drop` cuts it at once instead of flushing what is buffered (slow client). */
  close(drop = false): void {
    if (!this.open) return;
    this.open = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    if (drop) this.target.destroy();
    else this.target.end();
    this.options.onClose();
  }

  private flush(type: StreamEventName): void {
    this.timers.delete(type);
    const event = this.pending.get(type);
    this.pending.delete(type);
    if (event && this.open) this.writeEvent(event);
  }

  private writeEvent(event: StreamEvent): void {
    if (COALESCED_EVENTS.has(event.type)) this.lastSentAt.set(event.type, this.now());
    const id = this.options.nextId();
    this.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  private write(frame: string): void {
    if (!this.open) return;
    this.target.write(frame);
    if (this.target.writableLength > this.options.maxBufferedBytes) this.close(true);
  }
}
