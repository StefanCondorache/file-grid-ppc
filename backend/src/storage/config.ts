import { inspect } from 'node:util';

/**
 * Storage settings read from environment variables (port of P1's `config.py`: same variables,
 * same defaults, same validation). Defaults match the laptop stack from `make infra-up`.
 * Credentials have no defaults. Durations are given in seconds in the environment and kept in
 * milliseconds here.
 *
 * FILEGRID_STORAGE_DRIVER      `real` (default) or `memory` (all three names backed by an in-process
 *                              MemoryStorage, for local runs without S3/FTP; no credentials needed)
 *
 * S3     FILEGRID_S3_ENDPOINT (http://127.0.0.1:9000), S3_ACCESS_KEY, S3_SECRET_KEY (required),
 *        S3_BUCKET (filegrid), FILEGRID_S3_REGION (us-east-1), FILEGRID_S3_PART_SIZE (8 MiB, min 5 MiB),
 *        FILEGRID_S3_MAX_POOL (16)
 * FTP    FILEGRID_FTP_HOST (127.0.0.1), FILEGRID_FTP_PORT (21), FTP_USER, FTP_PASSWORD (required),
 *        FILEGRID_FTP_MAX_CONNECTIONS (4, plus one for health)
 * DB     FILEGRID_PG_DSN, or POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB (required then) with
 *        FILEGRID_PG_HOST (127.0.0.1) and FILEGRID_PG_PORT (5432); FILEGRID_PG_POOL_MAX (8),
 *        FILEGRID_PG_CHUNK_SIZE (1 MiB, 64 KiB..16 MiB)
 * Resilience  FILEGRID_STORAGE_BREAKER_FAILURES (5), FILEGRID_STORAGE_BREAKER_RESET_S (10),
 *        FILEGRID_STORAGE_HEALTH_INTERVAL_S (5), FILEGRID_STORAGE_HEALTH_TIMEOUT_S (2),
 *        FILEGRID_STORAGE_IDLE_TIMEOUT_S (30), FILEGRID_STORAGE_OP_TIMEOUT_S (10),
 *        FILEGRID_STORAGE_CONNECT_TIMEOUT_S (3, used by the adapters)
 *
 * Secrets never appear in `JSON.stringify`, `util.inspect` (and so pino) or error messages.
 */

export type Env = Readonly<Record<string, string | undefined>>;

const MiB = 1024 * 1024;
const REDACTED = '[redacted]';

/** A required storage setting is missing or invalid (the message never contains secret values). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function required(env: Env, name: string): string {
  const value = env[name] ?? '';
  if (!value) throw new ConfigError(`environment variable ${name} is required`);
  return value;
}

function text(env: Env, name: string, fallback: string): string {
  return env[name] || fallback;
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  return Number.parseInt(raw, 10);
}

function seconds(env: Env, name: string, fallbackSeconds: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallbackSeconds * 1000;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${name} must be a number`);
  return value * 1000;
}

function redacted<T extends object>(
  value: T,
  secrets: readonly (keyof T)[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of secrets) copy[String(key)] = REDACTED;
  return copy;
}

abstract class SecretSettings {
  protected abstract secretFields(): Record<string, unknown>;

  toJSON(): Record<string, unknown> {
    return this.secretFields();
  }

  toString(): string {
    return `${this.constructor.name} ${JSON.stringify(this.secretFields())}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export interface S3SettingsInit {
  endpoint?: string;
  accessKey: string;
  secretKey: string;
  bucket?: string;
  region?: string;
  partSize?: number;
  maxPool?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export class S3Settings extends SecretSettings {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly partSize: number;
  readonly maxPool: number;
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;

  constructor(init: S3SettingsInit) {
    super();
    this.endpoint = (init.endpoint ?? 'http://127.0.0.1:9000').replace(/\/+$/, '');
    this.accessKey = init.accessKey;
    this.secretKey = init.secretKey;
    this.bucket = init.bucket ?? 'filegrid';
    this.region = init.region ?? 'us-east-1';
    this.partSize = init.partSize ?? 8 * MiB;
    this.maxPool = init.maxPool ?? 16;
    this.connectTimeoutMs = init.connectTimeoutMs ?? 3000;
    this.readTimeoutMs = init.readTimeoutMs ?? 30_000;
  }

  static fromEnv(env: Env = process.env): S3Settings {
    const partSize = integer(env, 'FILEGRID_S3_PART_SIZE', 8 * MiB);
    if (partSize < 5 * MiB) {
      throw new ConfigError('FILEGRID_S3_PART_SIZE must be at least 5 MiB (S3 multipart minimum)');
    }
    return new S3Settings({
      endpoint: text(env, 'FILEGRID_S3_ENDPOINT', 'http://127.0.0.1:9000'),
      accessKey: required(env, 'S3_ACCESS_KEY'),
      secretKey: required(env, 'S3_SECRET_KEY'),
      bucket: text(env, 'S3_BUCKET', 'filegrid'),
      region: text(env, 'FILEGRID_S3_REGION', 'us-east-1'),
      partSize,
      maxPool: Math.max(1, integer(env, 'FILEGRID_S3_MAX_POOL', 16)),
      connectTimeoutMs: seconds(env, 'FILEGRID_STORAGE_CONNECT_TIMEOUT_S', 3),
    });
  }

  with(overrides: Partial<S3SettingsInit>): S3Settings {
    return new S3Settings({ ...this, ...overrides });
  }

  protected secretFields(): Record<string, unknown> {
    return redacted(this, ['accessKey', 'secretKey']);
  }
}

export interface FtpSettingsInit {
  host?: string;
  port?: number;
  user: string;
  password: string;
  maxConnections?: number;
  connectTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export class FtpSettings extends SecretSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly maxConnections: number;
  readonly connectTimeoutMs: number;
  readonly socketTimeoutMs: number;

  constructor(init: FtpSettingsInit) {
    super();
    this.host = init.host ?? '127.0.0.1';
    this.port = init.port ?? 21;
    this.user = init.user;
    this.password = init.password;
    this.maxConnections = Math.max(1, init.maxConnections ?? 4);
    this.connectTimeoutMs = init.connectTimeoutMs ?? 3000;
    this.socketTimeoutMs = init.socketTimeoutMs ?? 30_000;
  }

  static fromEnv(env: Env = process.env): FtpSettings {
    return new FtpSettings({
      host: text(env, 'FILEGRID_FTP_HOST', '127.0.0.1'),
      port: integer(env, 'FILEGRID_FTP_PORT', 21),
      user: required(env, 'FTP_USER'),
      password: required(env, 'FTP_PASSWORD'),
      maxConnections: integer(env, 'FILEGRID_FTP_MAX_CONNECTIONS', 4),
      connectTimeoutMs: seconds(env, 'FILEGRID_STORAGE_CONNECT_TIMEOUT_S', 3),
    });
  }

  with(overrides: Partial<FtpSettingsInit>): FtpSettings {
    return new FtpSettings({ ...this, ...overrides });
  }

  protected secretFields(): Record<string, unknown> {
    return redacted(this, ['user', 'password']);
  }
}

export interface DbSettingsInit {
  dsn: string;
  poolMax?: number;
  chunkSize?: number;
  connectTimeoutMs?: number;
  /** How long an operation waits for a free pooled connection before it gives up as busy. */
  acquireTimeoutMs?: number;
}

export class DbSettings extends SecretSettings {
  readonly dsn: string;
  readonly poolMax: number;
  readonly chunkSize: number;
  readonly connectTimeoutMs: number;
  readonly acquireTimeoutMs: number;

  constructor(init: DbSettingsInit) {
    super();
    this.dsn = init.dsn;
    this.poolMax = Math.max(1, init.poolMax ?? 8);
    this.chunkSize = init.chunkSize ?? MiB;
    this.connectTimeoutMs = init.connectTimeoutMs ?? 3000;
    this.acquireTimeoutMs = init.acquireTimeoutMs ?? 10_000;
  }

  static fromEnv(env: Env = process.env): DbSettings {
    let dsn = env.FILEGRID_PG_DSN ?? '';
    if (!dsn) {
      const user = encodeURIComponent(required(env, 'POSTGRES_USER'));
      const password = encodeURIComponent(required(env, 'POSTGRES_PASSWORD'));
      const db = encodeURIComponent(required(env, 'POSTGRES_DB'));
      const host = text(env, 'FILEGRID_PG_HOST', '127.0.0.1');
      const port = integer(env, 'FILEGRID_PG_PORT', 5432);
      dsn = `postgresql://${user}:${password}@${host}:${port}/${db}`;
    }
    const chunkSize = integer(env, 'FILEGRID_PG_CHUNK_SIZE', MiB);
    if (chunkSize < 64 * 1024 || chunkSize > 16 * MiB) {
      throw new ConfigError('FILEGRID_PG_CHUNK_SIZE must be between 64 KiB and 16 MiB');
    }
    return new DbSettings({
      dsn,
      poolMax: integer(env, 'FILEGRID_PG_POOL_MAX', 8),
      chunkSize,
      connectTimeoutMs: seconds(env, 'FILEGRID_STORAGE_CONNECT_TIMEOUT_S', 3),
    });
  }

  with(overrides: Partial<DbSettingsInit>): DbSettings {
    return new DbSettings({ ...this, ...overrides });
  }

  protected secretFields(): Record<string, unknown> {
    return redacted(this, ['dsn']);
  }
}

export interface ResilienceSettingsInit {
  breakerFailures?: number;
  breakerResetMs?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  idleTimeoutMs?: number;
  opTimeoutMs?: number;
}

export class ResilienceSettings {
  readonly breakerFailures: number;
  readonly breakerResetMs: number;
  readonly healthIntervalMs: number;
  readonly healthTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly opTimeoutMs: number;

  constructor(init: ResilienceSettingsInit = {}) {
    this.breakerFailures = Math.max(1, init.breakerFailures ?? 5);
    this.breakerResetMs = init.breakerResetMs ?? 10_000;
    this.healthIntervalMs = init.healthIntervalMs ?? 5000;
    this.healthTimeoutMs = init.healthTimeoutMs ?? 2000;
    this.idleTimeoutMs = init.idleTimeoutMs ?? 30_000;
    this.opTimeoutMs = init.opTimeoutMs ?? 10_000;
  }

  static fromEnv(env: Env = process.env): ResilienceSettings {
    return new ResilienceSettings({
      breakerFailures: integer(env, 'FILEGRID_STORAGE_BREAKER_FAILURES', 5),
      breakerResetMs: seconds(env, 'FILEGRID_STORAGE_BREAKER_RESET_S', 10),
      healthIntervalMs: seconds(env, 'FILEGRID_STORAGE_HEALTH_INTERVAL_S', 5),
      healthTimeoutMs: seconds(env, 'FILEGRID_STORAGE_HEALTH_TIMEOUT_S', 2),
      idleTimeoutMs: seconds(env, 'FILEGRID_STORAGE_IDLE_TIMEOUT_S', 30),
      opTimeoutMs: seconds(env, 'FILEGRID_STORAGE_OP_TIMEOUT_S', 10),
    });
  }
}

export type StorageDriver = 'real' | 'memory';

export interface StorageSettingsInit {
  driver?: StorageDriver;
  s3?: S3Settings | null;
  ftp?: FtpSettings | null;
  db?: DbSettings | null;
  resilience?: ResilienceSettings;
}

/** All storage settings. `s3`, `ftp` and `db` are null only with the `memory` driver. */
export class StorageSettings extends SecretSettings {
  readonly driver: StorageDriver;
  readonly s3: S3Settings | null;
  readonly ftp: FtpSettings | null;
  readonly db: DbSettings | null;
  readonly resilience: ResilienceSettings;

  constructor(init: StorageSettingsInit) {
    super();
    this.driver = init.driver ?? 'real';
    this.s3 = init.s3 ?? null;
    this.ftp = init.ftp ?? null;
    this.db = init.db ?? null;
    this.resilience = init.resilience ?? new ResilienceSettings();
    if (this.driver === 'real' && (!this.s3 || !this.ftp || !this.db)) {
      throw new ConfigError('the real storage driver needs S3, FTP and DB settings');
    }
  }

  static fromEnv(env: Env = process.env): StorageSettings {
    const driver = (env.FILEGRID_STORAGE_DRIVER ?? '').trim() || 'real';
    if (driver !== 'real' && driver !== 'memory') {
      throw new ConfigError('FILEGRID_STORAGE_DRIVER must be "real" or "memory"');
    }
    const resilience = ResilienceSettings.fromEnv(env);
    if (driver === 'memory') return new StorageSettings({ driver, resilience });
    return new StorageSettings({
      driver,
      s3: S3Settings.fromEnv(env),
      ftp: FtpSettings.fromEnv(env),
      db: DbSettings.fromEnv(env),
      resilience,
    });
  }

  protected secretFields(): Record<string, unknown> {
    return {
      driver: this.driver,
      s3: this.s3?.toJSON() ?? null,
      ftp: this.ftp?.toJSON() ?? null,
      db: this.db?.toJSON() ?? null,
      resilience: { ...this.resilience },
    };
  }
}
