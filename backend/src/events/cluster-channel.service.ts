import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'kysely';
import { Client } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';

export const EVENTS_CHANNEL = 'filegrid_events';
/** Session advisory lock held by the one replica that runs the periodic jobs ("FG" 0002). */
export const LEADER_LOCK_ID = 0x46470002;
/** NOTIFY payloads are limited to 8000 bytes; keep a margin. */
export const MAX_NOTIFY_BYTES = 7900;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const KEEPALIVE_DELAY_MS = 10_000;

export interface ClusterMessage {
  readonly origin: string;
  readonly payload: unknown;
}

type Listener = (payload: unknown) => void;

/**
 * Cross-replica messaging over Postgres, with no extra infrastructure: one dedicated connection per
 * process LISTENs on `filegrid_events` and holds the leader advisory lock; NOTIFY goes through the
 * regular pool. Messages a process sent itself are skipped (it already delivered them locally).
 * The connection reconnects with backoff; while it is down this replica is neither leader nor
 * listener, and every other part of the API keeps working.
 */
@Injectable()
export class ClusterChannel implements OnApplicationBootstrap, OnModuleDestroy {
  /** Identifies this process in the messages it sends. */
  readonly instanceId = randomUUID();
  private readonly logger = new Logger(ClusterChannel.name);
  private readonly listeners = new Set<Listener>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffMs = RECONNECT_MIN_MS;
  private leader = false;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  onApplicationBootstrap(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    await this.connecting?.catch(() => undefined);
    await this.drop();
  }

  /** True when the dedicated connection is up and LISTENing. */
  get listening(): boolean {
    return this.client !== null;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends to every other replica. Never throws: a lost hint is acceptable, a failed caller is not. */
  async broadcast(payload: unknown): Promise<boolean> {
    const message = JSON.stringify({ origin: this.instanceId, payload } satisfies ClusterMessage);
    if (Buffer.byteLength(message) > MAX_NOTIFY_BYTES) {
      this.logger.warn({ message: 'cluster message too large, sent to this replica only' });
      return false;
    }
    try {
      await sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${message})`.execute(this.db);
      return true;
    } catch (error) {
      this.logger.warn({
        message: 'could not broadcast a cluster message',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * True if this process holds the leader lock (taken on first call when free). Released only when
   * the dedicated connection closes, so another replica takes over after a crash or a restart.
   */
  async isLeader(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    if (this.leader) return true;
    try {
      const result = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        LEADER_LOCK_ID,
      ]);
      this.leader = this.client === client && result.rows[0]?.ok === true;
    } catch {
      this.leader = false;
    }
    return this.leader;
  }

  private connect(): Promise<void> {
    if (this.stopped || this.client || this.connecting) return this.connecting ?? Promise.resolve();
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const client = new Client({
      connectionString: this.config.databaseUrl,
      connectionTimeoutMillis: this.config.dbConnectTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    });
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client));
    client.on('notification', (message) => {
      if (message.channel === EVENTS_CHANNEL && message.payload) this.deliver(message.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (error) {
      client.removeAllListeners('end');
      client.end().catch(() => undefined);
      this.logger.warn({
        message: 'cluster channel could not connect; retrying',
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.backoffMs = RECONNECT_MIN_MS;
  }

  private deliver(raw: string): void {
    let message: ClusterMessage;
    try {
      message = JSON.parse(raw) as ClusterMessage;
    } catch {
      return;
    }
    if (message.origin === this.instanceId) return;
    for (const listener of this.listeners) {
      try {
        listener(message.payload);
      } catch (error) {
        this.logger.warn({
          message: 'cluster message listener failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private lost(client: Client, error?: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.leader = false;
    client.end().catch(() => undefined);
    if (this.stopped) return;
    this.logger.warn({
      message: 'cluster channel connection lost; reconnecting',
      error: error?.message ?? 'connection ended',
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), this.backoffMs);
    this.reconnectTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }

  private async drop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.leader = false;
    if (client) await client.end().catch(() => undefined);
  }
}
