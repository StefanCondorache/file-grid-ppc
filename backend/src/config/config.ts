import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const commaSeparated = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(480),
  ADMIN_USERNAME: z.string().min(1).max(64).default('admin'),
  ADMIN_PASSWORD: z.string({ error: 'is required' }).min(8, 'must be at least 8 characters'),
  OPERATOR_USERNAME: z.string().min(1).max(64).default('operator'),
  OPERATOR_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),
  METER_API_KEYS: commaSeparated.pipe(
    z.array(z.string().min(16, 'entries need 16+ characters')).min(1, 'must list at least one key'),
  ),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(10),
  LOGIN_WINDOW_S: z.coerce.number().int().min(1).default(300),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  CORS_ORIGINS: commaSeparated,
});

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolSize: number;
  readonly dbConnectTimeoutMs: number;
  readonly jwtSecret: string;
  readonly jwtTtlMinutes: number;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly operatorUsername: string;
  readonly operatorPassword: string | undefined;
  readonly meterApiKeys: readonly string[];
  readonly loginMaxFailures: number;
  readonly loginWindowS: number;
  readonly logLevel: LogLevel;
  readonly corsOrigins: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
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
    databaseUrl: e.DATABASE_URL,
    dbPoolSize: e.DB_POOL_SIZE,
    dbConnectTimeoutMs: e.DB_CONNECT_TIMEOUT_MS,
    jwtSecret: e.JWT_SECRET,
    jwtTtlMinutes: e.JWT_TTL_MINUTES,
    adminUsername: e.ADMIN_USERNAME,
    adminPassword: e.ADMIN_PASSWORD,
    operatorUsername: e.OPERATOR_USERNAME,
    operatorPassword: e.OPERATOR_PASSWORD,
    meterApiKeys: e.METER_API_KEYS,
    loginMaxFailures: e.LOGIN_MAX_FAILURES,
    loginWindowS: e.LOGIN_WINDOW_S,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS,
  };
}
