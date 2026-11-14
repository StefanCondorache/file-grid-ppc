// Test support: an in-process fake backend (node:http) that stores readings idempotently, plus small helpers.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import type { Logger } from '../src/log.ts';
import type { Reading } from '../src/readings.ts';

// Random per test run: no key, not even a fake one, is written in the repository.
export const TEST_API_KEY = randomBytes(18).toString('base64url');

export interface ReceivedRequest {
  readonly headers: IncomingHttpHeaders;
  readonly readings: readonly Reading[];
}

/** What the fake answers: a fixed status (optional headers/body), the normal store-and-200 after a delay
 *  ({ delayMs } without status), 'store-then-503' (stores but loses the ack), 'drop' (destroys the socket:
 *  network error) or 'hang' (never answers: client timeout). */
export type Scripted =
  | { readonly status?: number; readonly headers?: Record<string, string>; readonly body?: string; readonly delayMs?: number }
  | 'store-then-503'
  | 'drop'
  | 'hang';

export interface FakeBackend {
  readonly url: string;
  readonly requests: ReceivedRequest[];
  /** Unique stored readings by id (first write wins, like the real backend). */
  readonly stored: Map<string, Reading>;
  /** Readings received again after they were stored. */
  duplicateReceptions: number;
  /** Responses used before the default 200 behaviour, consumed in order. */
  readonly script: Scripted[];
  /** Optional per-request override used after the script is empty (e.g. random failures). */
  fallback: ((index: number) => Scripted | undefined) | undefined;
  close(): Promise<void>;
}

function storeAll(backend: FakeBackend, readings: readonly Reading[]): { stored: number; duplicates: number } {
  let stored = 0;
  let duplicates = 0;
  for (const r of readings) {
    if (backend.stored.has(r.readingId)) {
      duplicates += 1;
      backend.duplicateReceptions += 1;
    } else {
      backend.stored.set(r.readingId, r);
      stored += 1;
    }
  }
  return { stored, duplicates };
}

export async function startFakeBackend(options: { apiKey?: string } = {}): Promise<FakeBackend> {
  const apiKey = options.apiKey ?? TEST_API_KEY;
  const hanging = new Set<ServerResponse>();
  let server: Server | undefined;
  const backend: FakeBackend = {
    url: '',
    requests: [],
    stored: new Map(),
    duplicateReceptions: 0,
    script: [],
    fallback: undefined,
    close: async () => {
      for (const res of hanging) res.destroy();
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    },
  };
  const respondDefault = (req: IncomingMessage, res: ServerResponse, readings: readonly Reading[]): void => {
    if (req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"code":"UNAUTHENTICATED"}');
      return;
    }
    const { stored, duplicates } = storeAll(backend, readings);
    const traceId = String(req.headers['x-trace-id'] ?? '');
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'X-Trace-Id': traceId })
      .end(JSON.stringify({ received: readings.length, stored, duplicates, traceId }));
  };
  const respond = (req: IncomingMessage, res: ServerResponse, readings: readonly Reading[], step: Scripted | undefined): void => {
    if (step === 'drop') return void req.socket.destroy();
    if (step === 'hang') return void hanging.add(res);
    if (step === 'store-then-503') {
      storeAll(backend, readings);
      res.writeHead(503, { 'Retry-After': '0' }).end('{"code":"UNAVAILABLE"}');
      return;
    }
    if (step?.status !== undefined) {
      res.writeHead(step.status, { 'Content-Type': 'application/json', ...step.headers }).end(step.body ?? '{}');
      return;
    }
    respondDefault(req, res, readings);
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const index = backend.requests.length;
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readings: Reading[] };
      backend.requests.push({ headers: req.headers, readings: parsed.readings });
      const step = backend.script.shift() ?? backend.fallback?.(index);
      const delayMs = typeof step === 'object' ? (step.delayMs ?? 0) : 0;
      if (delayMs > 0) setTimeout(() => respond(req, res, parsed.readings, step), delayMs);
      else respond(req, res, parsed.readings, step);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return Object.assign(backend, { url: `http://127.0.0.1:${port}` });
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    backendUrl: 'http://127.0.0.1:1',
    apiKey: TEST_API_KEY,
    meterRate: 10,
    stormFactor: 10,
    port: 0,
    meterCount: 300,
    batchMax: 200,
    flushIntervalMs: 1000,
    duplicateRatio: 0,
    maxQueue: 20_000,
    maxRate: 1000,
    logLevel: 'error',
    ...overrides,
  };
}

/** Logger that keeps every line, for assertions. */
export function memoryLogger(secrets: readonly string[] = [TEST_API_KEY]): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ level: 'debug', secrets, write: (l) => lines.push(l) }), lines };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000, message = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
