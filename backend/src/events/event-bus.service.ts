import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ClusterChannel } from './cluster-channel.service';
import { STREAM_EVENTS, type StreamEvent, type StreamEventName } from './events.types';

type Subscriber = (event: StreamEvent) => void;

const EVENT_NAMES: ReadonlySet<string> = new Set(STREAM_EVENTS);

export interface PublishOptions {
  /** Deliver on this replica only (per-replica data such as its storage health view). */
  readonly localOnly?: boolean;
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; data?: unknown };
  return (
    typeof candidate.type === 'string' &&
    EVENT_NAMES.has(candidate.type) &&
    typeof candidate.data === 'object' &&
    candidate.data !== null
  );
}

/**
 * In-process publish/subscribe for live-stream events, fanned out to the other replicas through
 * the ClusterChannel (Postgres NOTIFY). Publishing never fails or slows the caller.
 */
@Injectable()
export class EventBus implements OnModuleInit {
  private readonly logger = new Logger(EventBus.name);
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly cluster: ClusterChannel) {}

  onModuleInit(): void {
    this.cluster.onMessage((payload) => {
      if (isStreamEvent(payload)) this.deliver(payload);
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(
    type: StreamEventName,
    data: StreamEvent['data'],
    audience?: StreamEvent['audience'],
    options: PublishOptions = {},
  ): void {
    const event: StreamEvent = audience ? { type, data, audience } : { type, data };
    this.deliver(event);
    if (!options.localOnly) void this.cluster.broadcast(event);
  }

  private deliver(event: StreamEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.logger.warn({
          message: 'stream subscriber failed',
          event: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
