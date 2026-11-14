import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '../auth/auth.types';
import { AppError, retryAfter } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { Lifecycle } from '../lifecycle/lifecycle';
import { storageHealthItems } from '../monitoring/storage-health';
import { ObjectStoreService } from '../object-store/object-store.service';
import { EventBus } from './event-bus.service';
import { type StreamEvent, visibleTo } from './events.types';
import { SseClient, nextEventId } from './sse-client';

/** Unsent bytes a client may have queued before it is dropped as too slow. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const HEALTH_WATCH_MS = 1000;

interface Subscription {
  readonly client: SseClient;
  readonly viewer: Principal;
  readonly closeTimer: NodeJS.Timeout;
}

/**
 * The open event streams of this replica (GET /stream). Every event from the EventBus goes to the
 * streams whose active role may see it; a `ping` goes to all of them every STREAM_PING_S. A stream
 * ends when its session does (idle, absolute or acting-role expiry), when the client leaves, and on
 * shutdown. This replica's own storage health is watched here and published when it changes.
 */
@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private readonly subscriptions = new Set<Subscription>();
  private unsubscribe: () => void = () => undefined;
  private unsubscribeStopping: () => void = () => undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private lastHealth = '';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: EventBus,
    private readonly store: ObjectStoreService,
    private readonly lifecycle: Lifecycle,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.dispatch(event));
    // Streams never end on their own: close them when shutdown starts, or they would hold the
    // drain until its timeout. EventSource reconnects, to a replica that is still ready.
    this.unsubscribeStopping = this.lifecycle.onStopping(() => this.closeAll());
    this.pingTimer = setInterval(() => this.ping(), this.config.stream.pingMs);
    this.pingTimer.unref();
    this.healthTimer = setInterval(() => this.watchHealth(), HEALTH_WATCH_MS);
    this.healthTimer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe();
    this.unsubscribeStopping();
    clearInterval(this.pingTimer);
    clearInterval(this.healthTimer);
    this.closeAll();
  }

  private closeAll(): void {
    // close() removes the subscription; deleting the current element while iterating a Set is safe.
    for (const subscription of this.subscriptions) subscription.client.close();
  }

  get size(): number {
    return this.subscriptions.size;
  }

  open(viewer: Principal, request: Request, response: Response): void {
    if (this.subscriptions.size >= this.config.stream.maxClients) {
      throw new AppError(
        503,
        'STREAM_BUSY',
        'Prea multe conexiuni live deschise. Reîncercați în câteva secunde.',
        { retryAfterMs: 5000 },
        retryAfter(5),
      );
    }
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);

    let subscription: Subscription | undefined;
    const client = new SseClient(response, {
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      nextId: nextEventId,
      onClose: () => {
        if (!subscription) return;
        clearTimeout(subscription.closeTimer);
        this.subscriptions.delete(subscription);
      },
    });
    const sessionEnds = Math.min(
      viewer.expiresAt.getTime(),
      viewer.idleExpiresAt.getTime(),
      viewer.actingRoleExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    const closeTimer = setTimeout(() => client.close(), Math.max(0, sessionEnds - Date.now()));
    closeTimer.unref();
    subscription = { client, viewer, closeTimer };
    this.subscriptions.add(subscription);
    request.once('close', () => client.close());
    client.start();
    client.send(this.pingEvent());
  }

  private dispatch(event: StreamEvent): void {
    for (const { client, viewer } of this.subscriptions) {
      if (visibleTo(event, viewer)) client.send(event);
    }
  }

  private pingEvent(): StreamEvent {
    return { type: 'ping', data: { serverTime: new Date().toISOString() } };
  }

  private ping(): void {
    const event = this.pingEvent();
    for (const { client } of this.subscriptions) client.send(event);
  }

  private watchHealth(): void {
    try {
      const items = storageHealthItems(this.store.status());
      const key = items.map((i) => `${i.storage}:${i.status}:${i.circuitState}`).join(',');
      if (key === this.lastHealth) return;
      const first = this.lastHealth === '';
      this.lastHealth = key;
      if (!first) this.bus.publish('storage.health', { items }, undefined, { localOnly: true });
    } catch (error) {
      this.logger.warn({
        message: 'storage health watch failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
