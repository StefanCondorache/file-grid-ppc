import { z } from 'zod';

/**
 * Backend settings from environment variables (12-factor). The names follow the team contract in the
 * README ("Contracte pentru P2/P3"): in k3s they come from the Secrets `filegrid-storage-credentials`
 * and `filegrid-app-secrets` plus FILEGRID_PG_HOST & co. set in deploy/k8s/app/backend/deployment.yaml.
 * Storage settings (S3_*, FTP_*, FILEGRID_S3_*, ...) are read by src/storage/config.ts.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  // Metadata database: the same PostgreSQL as the `db` storage, tables in schema public.
  FILEGRID_PG_DSN: z.string().optional(),
  FILEGRID_PG_HOST: z.string().default('127.0.0.1'),
  FILEGRID_PG_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  FILEGRID_DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(8),
  FILEGRID_DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(480),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(10_080).default(30),
  COOKIE_SECURE: bool.default(true),
  ADMIN_USERNAME: z.string().min(1).max(64).default('admin'),
  ADMIN_PASSWORD: z.string({ error: 'is required' }).min(8, 'must be at least 8 characters'),
  METER_API_KEY: z.string({ error: 'is required' }).min(16, 'must be at least 16 characters'),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(10),
  LOGIN_WINDOW_S: z.coerce.number().int().min(1).default(300),
  FILEGRID_DEMO_MODE: bool.default(true),
  // Password of the per-role demo accounts (teren, dispecerat, racordari, auditor); default ADMIN_PASSWORD.
  DEMO_USERS_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),
  SIMULATOR_URL: z.string().url().default('http://filegrid-simulator.filegrid.svc:8080'),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Live stream (GET /stream, ADR-0008).
  STREAM_PING_S: z.coerce.number().min(0.1).max(300).default(20),
  STREAM_COUNTERS_INTERVAL_S: z.coerce.number().min(0.5).max(300).default(2),
  STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).max(10_000).default(200),
  // Envelope encryption keys (Secret filegrid-app-secrets); parsed and checked by src/crypto/keys.ts.
  FILEGRID_KEK: z.string().optional(),
  FILEGRID_KEK_ID: z.string().optional(),
  FILEGRID_KEK_RETIRED: z.string().optional(),
});

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolSize: number;
  readonly dbConnectTimeoutMs: number;
  readonly jwtSecret: string;
  readonly sessionTtlMinutes: number;
  readonly sessionIdleMinutes: number;
  readonly cookieSecure: boolean;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly meterApiKey: string;
  readonly loginMaxFailures: number;
  readonly loginWindowS: number;
  readonly demoMode: boolean;
  readonly demoUsersPassword: string;
  readonly simulatorUrl: string;
  readonly uploadSessionTtlHours: number;
  readonly logLevel: LogLevel;
  readonly stream: {
    readonly pingMs: number;
    readonly countersIntervalMs: number;
    readonly maxClients: number;
  };
  /** The FILEGRID_KEK* variables, handed to Keyring.fromEnv (never logged). */
  readonly kekEnv: Readonly<Record<string, string | undefined>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = z.infer<typeof envSchema>;

function databaseUrl(e: Env): string {
  if (e.FILEGRID_PG_DSN) return e.FILEGRID_PG_DSN;
  const missing = (['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'] as const).filter(
    (name) => !e[name],
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `Invalid configuration: set FILEGRID_PG_DSN or ${missing.join(', ')} (required)`,
    );
  }
  const part = (value: string | undefined): string => encodeURIComponent(value ?? '');
  return `postgresql://${part(e.POSTGRES_USER)}:${part(e.POSTGRES_PASSWORD)}@${e.FILEGRID_PG_HOST}:${e.FILEGRID_PG_PORT}/${part(e.POSTGRES_DB)}`;
}

/** The metadata database URL alone (for the migration entry point, which needs nothing else). */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const parsed = envSchema
    .pick({
      FILEGRID_PG_DSN: true,
      FILEGRID_PG_HOST: true,
      FILEGRID_PG_PORT: true,
      POSTGRES_USER: true,
      POSTGRES_PASSWORD: true,
      POSTGRES_DB: true,
    })
    .parse(env);
  return databaseUrl(parsed as Env);
}

/** Reads and validates the environment. Messages name the variable, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: databaseUrl(e),
    dbPoolSize: e.FILEGRID_DB_POOL_SIZE,
    dbConnectTimeoutMs: e.FILEGRID_DB_CONNECT_TIMEOUT_MS,
    jwtSecret: e.JWT_SECRET,
    sessionTtlMinutes: e.SESSION_TTL_MINUTES,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    cookieSecure: e.COOKIE_SECURE,
    adminUsername: e.ADMIN_USERNAME,
    adminPassword: e.ADMIN_PASSWORD,
    meterApiKey: e.METER_API_KEY,
    loginMaxFailures: e.LOGIN_MAX_FAILURES,
    loginWindowS: e.LOGIN_WINDOW_S,
    demoMode: e.FILEGRID_DEMO_MODE,
    demoUsersPassword: e.DEMO_USERS_PASSWORD ?? e.ADMIN_PASSWORD,
    simulatorUrl: e.SIMULATOR_URL,
    uploadSessionTtlHours: e.UPLOAD_SESSION_TTL_HOURS,
    logLevel: e.LOG_LEVEL,
    stream: {
      pingMs: Math.round(e.STREAM_PING_S * 1000),
      countersIntervalMs: Math.round(e.STREAM_COUNTERS_INTERVAL_S * 1000),
      maxClients: e.STREAM_MAX_CLIENTS,
    },
    kekEnv: {
      FILEGRID_KEK: e.FILEGRID_KEK,
      FILEGRID_KEK_ID: e.FILEGRID_KEK_ID,
      FILEGRID_KEK_RETIRED: e.FILEGRID_KEK_RETIRED,
    },
  };
}
