// Environment configuration. Every problem is collected and reported at once, so a bad deploy fails fast
// with one clear message. The API key value never appears in an error message.

import { LOG_LEVELS } from './log.ts';
import type { LogLevel } from './log.ts';

export interface Config {
  readonly backendUrl: string;
  readonly apiKey: string;
  readonly meterRate: number;
  readonly stormFactor: number;
  readonly port: number;
  readonly meterCount: number;
  readonly batchMax: number;
  readonly flushIntervalMs: number;
  readonly duplicateRatio: number;
  readonly maxQueue: number;
  readonly maxRate: number;
  readonly logLevel: LogLevel;
}

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid simulator configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// The backend accepts at most 500 readings per request; sequence numbers start at the startup time in ms,
// which stays unique across restarts only while one meter sends at most 1000 readings per second.
const BACKEND_BATCH_LIMIT = 500;
const MAX_READINGS_PER_METER_PER_S = 1000;
const MAX_METERS_PER_ZONE = 999_999;

interface NumberRule {
  readonly name: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

function readNumber(env: Env, rule: NumberRule, problems: string[]): number {
  const raw = env[rule.name]?.trim();
  if (raw === undefined || raw === '') return rule.fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${rule.name} must be a number, got "${raw}"`);
    return rule.fallback;
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    problems.push(`${rule.name} must be an integer, got "${raw}"`);
    return rule.fallback;
  }
  if (value < rule.min || value > rule.max) {
    problems.push(`${rule.name} must be between ${rule.min} and ${rule.max}, got ${value}`);
    return rule.fallback;
  }
  return value;
}

function readBackendUrl(env: Env, problems: string[]): string {
  const raw = env.BACKEND_URL?.trim() || 'http://127.0.0.1:8000';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`BACKEND_URL must use http or https, got "${url.protocol}"`);
    }
    if (url.username !== '' || url.password !== '') problems.push('BACKEND_URL must not contain credentials');
    return raw.replace(/\/+$/, '');
  } catch {
    problems.push(`BACKEND_URL is not a valid URL: "${raw}"`);
    return raw;
  }
}

function readApiKey(env: Env, problems: string[]): string {
  const key = env.METER_API_KEY?.trim() ?? '';
  if (key === '') problems.push('METER_API_KEY is required');
  else if (/[\r\n]/.test(key)) problems.push('METER_API_KEY must be a single line');
  return key;
}

function readLogLevel(env: Env, problems: string[]): LogLevel {
  const raw = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  const level = LOG_LEVELS.find((l) => l === raw);
  if (level === undefined) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
    return 'info';
  }
  return level;
}

function checkCrossFieldRules(config: Config, problems: string[]): void {
  if (config.meterRate > config.maxRate) {
    problems.push(`METER_RATE (${config.meterRate}) must not exceed MAX_RATE (${config.maxRate})`);
  }
  if (config.maxQueue < config.batchMax) {
    problems.push(`MAX_QUEUE (${config.maxQueue}) must be at least BATCH_MAX (${config.batchMax})`);
  }
  if (config.maxRate / config.meterCount > MAX_READINGS_PER_METER_PER_S) {
    problems.push(`MAX_RATE / METER_COUNT must stay at or below ${MAX_READINGS_PER_METER_PER_S} readings/s per meter`);
  }
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const config: Config = {
    backendUrl: readBackendUrl(env, problems),
    apiKey: readApiKey(env, problems),
    meterRate: readNumber(env, { name: 'METER_RATE', fallback: 10, min: 0, max: 100_000 }, problems),
    stormFactor: readNumber(env, { name: 'STORM_FACTOR', fallback: 10, min: 1, max: 1000 }, problems),
    port: readNumber(env, { name: 'PORT', fallback: 8080, min: 0, max: 65_535, integer: true }, problems),
    meterCount: readNumber(
      env,
      { name: 'METER_COUNT', fallback: 300, min: 1, max: MAX_METERS_PER_ZONE, integer: true },
      problems,
    ),
    batchMax: readNumber(
      env,
      { name: 'BATCH_MAX', fallback: 200, min: 1, max: BACKEND_BATCH_LIMIT, integer: true },
      problems,
    ),
    flushIntervalMs: readNumber(
      env,
      { name: 'FLUSH_INTERVAL_MS', fallback: 1000, min: 10, max: 60_000, integer: true },
      problems,
    ),
    duplicateRatio: readNumber(env, { name: 'DUPLICATE_RATIO', fallback: 0.02, min: 0, max: 1 }, problems),
    maxQueue: readNumber(env, { name: 'MAX_QUEUE', fallback: 20_000, min: 1, max: 1_000_000, integer: true }, problems),
    maxRate: readNumber(env, { name: 'MAX_RATE', fallback: 1000, min: 0.001, max: 100_000 }, problems),
    logLevel: readLogLevel(env, problems),
  };
  if (problems.length === 0) checkCrossFieldRules(config, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
