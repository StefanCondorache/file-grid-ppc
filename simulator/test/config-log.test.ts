import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';

const KEY = 'super-secret-meter-key';

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return [...err.problems];
  }
  assert.fail('expected a ConfigError');
}

describe('config', () => {
  it('applies the documented defaults', () => {
    assert.deepEqual(loadConfig({ METER_API_KEY: KEY }), {
      backendUrl: 'http://127.0.0.1:8000',
      apiKey: KEY,
      meterRate: 10,
      stormFactor: 10,
      port: 8080,
      meterCount: 300,
      batchMax: 200,
      flushIntervalMs: 1000,
      duplicateRatio: 0.02,
      maxQueue: 20_000,
      maxRate: 1000,
      logLevel: 'info',
    });
  });

  it('reads every variable and strips a trailing slash from BACKEND_URL', () => {
    const config = loadConfig({
      BACKEND_URL: 'http://filegrid-backend.filegrid.svc:8000/',
      METER_API_KEY: ` ${KEY} `,
      METER_RATE: '25.5',
      STORM_FACTOR: '4',
      PORT: '9090',
      METER_COUNT: '1000',
      BATCH_MAX: '100',
      FLUSH_INTERVAL_MS: '250',
      DUPLICATE_RATIO: '0',
      MAX_QUEUE: '5000',
      MAX_RATE: '500',
      LOG_LEVEL: 'DEBUG',
    });
    assert.equal(config.backendUrl, 'http://filegrid-backend.filegrid.svc:8000');
    assert.equal(config.apiKey, KEY);
    assert.equal(config.meterRate, 25.5);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.maxQueue, 5000);
  });

  it('requires METER_API_KEY', () => {
    assert.deepEqual(problemsOf({}), ['METER_API_KEY is required']);
    assert.deepEqual(problemsOf({ METER_API_KEY: '   ' }), ['METER_API_KEY is required']);
  });

  it('reports every invalid value at once, without echoing the key', () => {
    const problems = problemsOf({
      METER_API_KEY: KEY,
      BACKEND_URL: 'ftp://backend',
      METER_RATE: 'ten',
      PORT: '80.5',
      BATCH_MAX: '501',
      DUPLICATE_RATIO: '2',
      LOG_LEVEL: 'verbose',
    });
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('BACKEND_URL must use http or https')));
    assert.ok(problems.some((p) => p.startsWith('METER_RATE must be a number')));
    assert.ok(problems.some((p) => p.startsWith('PORT must be an integer')));
    assert.ok(problems.some((p) => p.startsWith('BATCH_MAX must be between 1 and 500')));
    assert.ok(problems.some((p) => p.startsWith('DUPLICATE_RATIO must be between 0 and 1')));
    assert.ok(problems.some((p) => p.startsWith('LOG_LEVEL must be one of')));
    assert.ok(problems.every((p) => !p.includes(KEY)));
  });

  it('checks cross-field rules', () => {
    assert.deepEqual(problemsOf({ METER_API_KEY: KEY, METER_RATE: '2000' }), [
      'METER_RATE (2000) must not exceed MAX_RATE (1000)',
    ]);
    assert.deepEqual(problemsOf({ METER_API_KEY: KEY, MAX_QUEUE: '100' }), [
      'MAX_QUEUE (100) must be at least BATCH_MAX (200)',
    ]);
    assert.deepEqual(problemsOf({ METER_API_KEY: KEY, METER_COUNT: '1', MAX_RATE: '5000', METER_RATE: '1' }), [
      'MAX_RATE / METER_COUNT must stay at or below 1000 readings/s per meter',
    ]);
    assert.deepEqual(problemsOf({ METER_API_KEY: KEY, BACKEND_URL: 'not a url' }), [
      'BACKEND_URL is not a valid URL: "not a url"',
    ]);
    assert.deepEqual(problemsOf({ METER_API_KEY: KEY, BACKEND_URL: 'http://user:pw@backend' }), [
      'BACKEND_URL must not contain credentials',
    ]);
  });
});

describe('logger', () => {
  it('writes one JSON line per event with level, time and message', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', write: (l) => lines.push(l), now: () => 0 });
    log.info('hello', { a: 1 });
    log.debug('hidden');
    log.error('boom', { error: new Error('bad', { cause: new Error('root') }) });
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ''), { level: 'info', time: '1970-01-01T00:00:00.000Z', message: 'hello', a: 1 });
    const err = JSON.parse(lines[1] ?? '') as { error: { message: string; cause: { message: string } } };
    assert.equal(err.error.message, 'bad');
    assert.equal(err.error.cause.message, 'root');
  });

  it('masks the API key wherever it appears', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', secrets: [KEY], write: (l) => lines.push(l) });
    log.warn(`header X-API-Key: ${KEY}`, { nested: { key: KEY } });
    assert.ok(!lines[0]?.includes(KEY));
    assert.equal((lines[0]?.match(/\[REDACTED\]/g) ?? []).length, 2);
  });
});
