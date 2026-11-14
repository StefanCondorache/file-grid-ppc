// One JSON object per line on stdout: {"level","time","message",...fields}.
// Any configured secret (the meter API key) is masked even if a caller passes it by mistake.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogLevel;
  secrets?: readonly string[];
  write?: (line: string) => void;
  now?: () => number;
}

const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 4;

function serializeError(err: Error): LogFields {
  const code = (err as { code?: unknown }).code;
  const cause = err.cause instanceof Error ? serializeError(err.cause) : undefined;
  return { name: err.name, message: err.message, ...(code === undefined ? {} : { code }), ...(cause ? { cause } : {}) };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const secrets = (options.secrets ?? []).filter((s) => s.length >= MIN_SECRET_LENGTH);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const entry = { level, time: new Date(now()).toISOString(), message, ...fields };
    let line = JSON.stringify(entry, jsonReplacer);
    for (const secret of secrets) line = line.replaceAll(secret, REDACTED);
    write(line);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
