import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { ensureSeedUsers } from '../auth/user-seeder';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../database/database';
import { migrateToLatest } from '../database/migrator';
import { ROOT_LOGGER } from '../observability/logger';
import { Lifecycle } from './lifecycle';
import { retryWithBackoff } from './retry';

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

/**
 * The start-up work that needs the metadata database: reach it (DNS and connection retried with
 * backoff), apply the migrations (Kysely holds a Postgres advisory lock, so replicas take turns)
 * and create the accounts from the environment. It runs after the HTTP server is listening, so
 * /healthz answers and /readyz says 503 `starting` meanwhile. When the database stays unreachable
 * for FILEGRID_DB_BOOT_TIMEOUT_S, `ready` rejects and main.ts exits (Kubernetes restarts the pod).
 */
@Injectable()
export class BootService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly abort = new AbortController();
  private boot: Promise<void> | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly lifecycle: Lifecycle,
  ) {}

  /** Resolves once the app is ready; rejects with RetryTimeoutError when the budget is spent. */
  get ready(): Promise<void> {
    if (!this.boot) {
      this.boot = this.run();
      this.boot.catch(() => undefined); // the caller of `ready` handles the failure
    }
    return this.boot;
  }

  onApplicationBootstrap(): void {
    void this.ready.catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.abort.abort();
  }

  private async run(): Promise<void> {
    const started = Date.now();
    try {
      const applied = await retryWithBackoff(
        async () => {
          await sql`SELECT 1`.execute(this.db);
          const migrations = await migrateToLatest(this.db);
          await ensureSeedUsers(this.db, this.config);
          return migrations;
        },
        {
          timeoutMs: this.config.dbBootTimeoutMs,
          minDelayMs: RETRY_MIN_MS,
          maxDelayMs: RETRY_MAX_MS,
          signal: this.abort.signal,
          onRetry: (error, attempt, delayMs) =>
            this.logger.warn(
              { attempt, retry_in_ms: delayMs, error: messageOf(error) },
              'database not ready at startup; retrying',
            ),
        },
      );
      this.lifecycle.markRunning();
      this.logger.info(
        { migrations_applied: applied, boot_ms: Date.now() - started },
        'database ready; accepting traffic',
      );
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.logger.fatal(
          { error: messageOf(error), timeout_s: this.config.dbBootTimeoutMs / 1000 },
          'database not reachable at startup; giving up',
        );
      }
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
