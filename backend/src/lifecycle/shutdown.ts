import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { Logger } from 'pino';
import { Lifecycle } from './lifecycle';

export interface ShutdownOptions {
  /** How long in-flight requests may take to finish before their connections are cut. */
  readonly drainTimeoutMs: number;
  readonly logger?: Logger;
}

/** After the drain, how long the server may take to see its last sockets close. */
const CLOSE_GRACE_MS = 1000;

function serverClosed(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The SIGTERM sequence of a rolling update or an HPA scale-down:
 *   1. readiness turns 503 and the live event streams end (clients reconnect to another replica);
 *   2. the server stops accepting connections (idle keep-alive ones close);
 *   3. in-flight requests finish, for at most drainTimeoutMs, then whatever is left is cut;
 *   4. app.close(): the DB pool, the storages and the timers close last.
 * Nest's own shutdown hooks run step 4 first, while requests are still being served: those
 * requests then fail with HTTP 500 ("driver has already been destroyed").
 */
export async function gracefulShutdown(
  app: INestApplication,
  options: ShutdownOptions,
): Promise<void> {
  const lifecycle = app.get(Lifecycle);
  const server = app.getHttpServer() as Server;
  const started = Date.now();
  lifecycle.beginStopping();
  const closed = serverClosed(server);
  const drained = await lifecycle.waitForIdle(options.drainTimeoutMs);
  server.closeIdleConnections();
  if (!drained || !(await within(closed, CLOSE_GRACE_MS))) {
    options.logger?.warn(
      { in_flight: lifecycle.requestsInFlight, drain_timeout_ms: options.drainTimeoutMs },
      'shutdown: cutting connections still open after the drain',
    );
    server.closeAllConnections();
  }
  await closed;
  await app.close();
  options.logger?.info({ shutdown_ms: Date.now() - started }, 'shutdown complete');
}

export interface SignalOptions extends ShutdownOptions {
  readonly signals?: readonly NodeJS.Signals[];
  /** Test hooks: where the signals come from and how the process exits. */
  readonly target?: NodeJS.EventEmitter;
  readonly exit?: (code: number) => void;
}

/**
 * Runs gracefulShutdown once on the first SIGTERM/SIGINT (later signals are ignored; Kubernetes
 * sends SIGKILL after terminationGracePeriodSeconds anyway), then exits. Returns `stop`, which
 * runs the same sequence for another reason (a failed boot) with its own exit code.
 */
export function handleShutdownSignals(
  app: INestApplication,
  options: SignalOptions,
): (exitCode: number, reason: string) => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const stop = (exitCode: number, reason: string): void => {
    if (stopping) return;
    stopping = true;
    options.logger?.info({ reason }, 'shutdown started');
    gracefulShutdown(app, options).then(
      () => exit(exitCode),
      (error: unknown) => {
        options.logger?.error({ err: error }, 'shutdown failed');
        exit(1);
      },
    );
  };
  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT']) {
    target.on(signal, () => stop(0, signal));
  }
  return stop;
}
