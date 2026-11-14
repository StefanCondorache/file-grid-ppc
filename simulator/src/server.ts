// HTTP endpoints on PORT: /healthz, GET/PUT /control and /metrics. Cluster-internal only: the NetworkPolicy
// admits just the backend (demo panel) and Prometheus.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { parseControlUpdate } from './control.ts';
import type { ControlUpdate } from './control.ts';
import type { Logger } from './log.ts';
import type { ControlStatus } from './simulator.ts';

export const MAX_BODY_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ControlApi {
  status(): ControlStatus;
  applyControl(update: ControlUpdate): ControlStatus;
  renderMetrics(): string;
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { code, message }, headers);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError());
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePutControl(req: IncomingMessage, res: ServerResponse, api: ControlApi, log: Logger): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', `body must be at most ${MAX_BODY_BYTES} bytes`, { Connection: 'close' });
      return;
    }
    throw err;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'VALIDATION_FAILED', 'body must be valid JSON');
    return;
  }
  const parsed = parseControlUpdate(body);
  if (!parsed.ok) {
    sendError(res, 400, 'VALIDATION_FAILED', parsed.message);
    return;
  }
  log.info('control update received', { ...parsed.value, remote: req.socket.remoteAddress });
  sendJson(res, 200, api.applyControl(parsed.value));
}

type Route = Readonly<Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>>;

function buildRoutes(api: ControlApi, log: Logger): Readonly<Record<string, Route>> {
  return {
    '/healthz': { GET: (_req, res) => sendJson(res, 200, { status: 'ok' }) },
    '/control': {
      GET: (_req, res) => sendJson(res, 200, api.status()),
      PUT: (req, res) => handlePutControl(req, res, api, log),
    },
    '/metrics': {
      GET: (_req, res) => {
        const text = api.renderMetrics();
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        });
        res.end(text);
      },
    },
  };
}

export function createControlServer(api: ControlApi, log: Logger): Server {
  const routes = buildRoutes(api, log);
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (route === undefined) {
      sendError(res, 404, 'NOT_FOUND', `no route for ${path}`);
      return;
    }
    const method = req.method ?? 'GET';
    const handler = Object.hasOwn(route, method) ? route[method] : undefined;
    if (handler === undefined) {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on ${path}`, { Allow: Object.keys(route).join(', ') });
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err: unknown) => {
        log.error('control request failed', { path, method, error: err });
        if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'internal error');
        else res.destroy();
      });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
