import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Level, type Logger, type LoggerOptions } from 'pino';
import { currentTraceId } from './trace-context';

export const ROOT_LOGGER = Symbol('ROOT_LOGGER');

/** One JSON object per line on stdout, each carrying the current trace id (searchable in Loki). */
export function createRootLogger(level: string, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level,
    base: null,
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ trace_id: currentTraceId() ?? null }),
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Routes Nest's own logger (and `new Logger(context)` in services) into pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    const last = params.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const stack =
      level === 'error' && params.length > 1 && typeof params[0] === 'string'
        ? params[0]
        : undefined;
    const base = { ...(context ? { context } : {}), ...(stack ? { stack } : {}) };
    if (message instanceof Error) {
      this.logger[level]({ ...base, err: message }, message.message);
      return;
    }
    if (message !== null && typeof message === 'object') {
      const { message: text, ...fields } = message as Record<string, unknown>;
      this.logger[level]({ ...base, ...fields }, typeof text === 'string' ? text : '');
      return;
    }
    this.logger[level](base, String(message));
  }
}
