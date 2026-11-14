import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * starting: the database is not reachable (or not migrated) yet; /readyz answers 503.
 * running: /readyz answers 200 (`degraded` when a dependency is down: README contract).
 * stopping: SIGTERM received; /readyz answers 503 while the in-flight requests finish.
 */
export type LifecycleState = 'starting' | 'running' | 'stopping';

/**
 * Where this process is in its life, and the HTTP requests it is serving right now. Readiness
 * (/readyz), the boot (BootService) and the shutdown (gracefulShutdown) share it.
 */
@Injectable()
export class Lifecycle {
  private readonly logger = new Logger(Lifecycle.name);
  private current: LifecycleState = 'starting';
  private inFlight = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly stoppingListeners = new Set<() => void>();

  get state(): LifecycleState {
    return this.current;
  }

  /** HTTP requests whose response has not closed yet. */
  get requestsInFlight(): number {
    return this.inFlight;
  }

  /** The boot is done: database reachable, schema current, accounts seeded. */
  markRunning(): void {
    if (this.current === 'starting') this.current = 'running';
  }

  /** Readiness turns 503 and every `onStopping` listener runs (once). */
  beginStopping(): void {
    if (this.current === 'stopping') return;
    this.current = 'stopping';
    for (const listener of this.stoppingListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn({
          message: 'shutdown listener failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Runs `listener` when shutdown starts (to end long-lived streams). Returns an unsubscribe. */
  onStopping(listener: () => void): () => void {
    this.stoppingListeners.add(listener);
    return () => this.stoppingListeners.delete(listener);
  }

  /**
   * Express middleware: counts each request until its response closes (finished or aborted).
   * While stopping, responses carry `Connection: close` so clients do not reuse the connection.
   */
  middleware(): RequestHandler {
    return (_request: Request, response: Response, next: NextFunction): void => {
      this.inFlight += 1;
      if (this.current === 'stopping') response.setHeader('Connection', 'close');
      response.once('close', () => {
        this.inFlight -= 1;
        // wake() removes itself; deleting the current element while iterating a Set is safe.
        if (this.inFlight === 0) for (const wake of this.idleWaiters) wake();
      });
      next();
    };
  }

  /** True once no request is in flight; false if some still are after `timeoutMs`. */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (idle: boolean): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolve(idle);
      };
      const wake = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(wake);
    });
  }
}
