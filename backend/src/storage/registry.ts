import { type StorageAdapter, type StorageName, STORAGE_NAMES } from './base';
import { ResilienceSettings, type StorageSettings } from './config';
import { DbStorage } from './db';
import { FtpStorage } from './ftp';
import { MemoryStorage } from './memory';
import {
  type BreakerStateName,
  CircuitBreaker,
  HealthMonitor,
  ResilientStorage,
  type StorageLogger,
} from './resilience';
import { S3Storage } from './s3';

/**
 * The three FileGrid storages, each wrapped in a ResilientStorage (circuit breaker, timeouts,
 * metrics), plus the background health monitor. Port of P1's `registry.py`.
 *
 *   const registry = StorageRegistry.fromSettings(StorageSettings.fromEnv(process.env), logger);
 *   await registry.start();                       // DB schema (best effort) + health monitor
 *   const storage = registry.get(policy.primaryStorage);
 *   await withCategory('fault_records', () => storage.putStream(key, chunks));
 *   // StorageUnavailable (down, timed out, circuit open in microseconds) -> use the fallback
 *   await registry.close();
 */
export interface StorageStatus {
  readonly up: boolean | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  readonly circuit: BreakerStateName;
  readonly lastCheckAt: string | null;
}

export class StorageRegistry {
  readonly monitor: HealthMonitor;
  private readonly storages: Map<StorageName, ResilientStorage>;

  constructor(
    storages: Iterable<ResilientStorage>,
    readonly resilience: ResilienceSettings = new ResilienceSettings(),
    private readonly logger?: StorageLogger,
  ) {
    this.storages = new Map([...storages].map((s) => [s.name, s]));
    this.monitor = new HealthMonitor(this.storages.values(), {
      intervalMs: resilience.healthIntervalMs,
      logger,
    });
  }

  static fromAdapters(
    adapters: Iterable<StorageAdapter>,
    resilience: ResilienceSettings = new ResilienceSettings(),
    logger?: StorageLogger,
  ): StorageRegistry {
    const wrapped = [...adapters].map(
      (adapter) =>
        new ResilientStorage(adapter, {
          breaker: new CircuitBreaker(adapter.name, {
            failureThreshold: resilience.breakerFailures,
            resetTimeoutMs: resilience.breakerResetMs,
            logger,
          }),
          idleTimeoutMs: resilience.idleTimeoutMs,
          opTimeoutMs: resilience.opTimeoutMs,
          healthTimeoutMs: resilience.healthTimeoutMs,
          logger,
        }),
    );
    return new StorageRegistry(wrapped, resilience, logger);
  }

  static fromSettings(settings: StorageSettings, logger?: StorageLogger): StorageRegistry {
    const adapters: StorageAdapter[] =
      settings.driver === 'memory' || !settings.s3 || !settings.ftp || !settings.db
        ? STORAGE_NAMES.map((name) => new MemoryStorage(name))
        : [
            new S3Storage(settings.s3, { logger }),
            new FtpStorage(settings.ftp, { logger }),
            new DbStorage(settings.db, { logger }),
          ];
    return StorageRegistry.fromAdapters(adapters, settings.resilience, logger);
  }

  get names(): StorageName[] {
    return [...this.storages.keys()];
  }

  get(name: StorageName): ResilientStorage {
    const storage = this.storages.get(name);
    if (!storage) throw new Error(`unknown storage ${name}`);
    return storage;
  }

  /** Creates the DB schema (best effort: a DB that is down must not stop the app) and starts polling. */
  async start(options: { monitor?: boolean } = {}): Promise<void> {
    const db = this.storages.get('db');
    if (db?.adapter instanceof DbStorage) {
      try {
        await db.adapter.ensureSchema();
      } catch (error) {
        this.logger?.warn(
          { storage: 'db', error: error instanceof Error ? error.message : String(error) },
          'blobstore schema not ensured at startup; retried on first use',
        );
      }
    }
    if (options.monitor ?? true) {
      await this.monitor.checkOnce();
      this.monitor.start();
    }
  }

  status(): Record<StorageName, StorageStatus> {
    const out = {} as Record<StorageName, StorageStatus>;
    for (const [name, s] of this.storages) {
      out[name] = {
        up: s.lastHealth?.ok ?? null,
        latencyMs: s.lastHealth ? Math.round(s.lastHealth.latencyMs * 100) / 100 : null,
        detail: s.lastHealth?.detail ?? null,
        circuit: s.breaker.stateName,
        lastCheckAt: s.lastHealthAt?.toISOString() ?? null,
      };
    }
    return out;
  }

  async close(): Promise<void> {
    await this.monitor.stop();
    for (const storage of this.storages.values()) {
      try {
        await storage.close();
      } catch (error) {
        this.logger?.warn(
          { storage: storage.name, error: error instanceof Error ? error.message : String(error) },
          'storage close failed',
        );
      }
    }
  }
}
