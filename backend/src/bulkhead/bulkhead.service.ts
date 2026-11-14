import { Injectable } from '@nestjs/common';
import { Counter, Gauge, register } from 'prom-client';
import { AppError, retryAfter } from '../common/app-error';
import type { Category } from '../common/domain';

function metric<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

const IN_FLIGHT = metric(
  'filegrid_bulkhead_in_flight',
  () =>
    new Gauge({
      name: 'filegrid_bulkhead_in_flight',
      help: 'Storage operations running now, per category (bulkhead).',
      labelNames: ['category'],
    }),
);
const QUEUED = metric(
  'filegrid_bulkhead_queued',
  () =>
    new Gauge({
      name: 'filegrid_bulkhead_queued',
      help: 'Operations waiting for a bulkhead slot, per category.',
      labelNames: ['category'],
    }),
);
const REJECTED = metric(
  'filegrid_bulkhead_rejected_total',
  () =>
    new Counter({
      name: 'filegrid_bulkhead_rejected_total',
      help: 'Operations refused because the category bulkhead and its queue were full.',
      labelNames: ['category'],
    }),
);

/** How many waiters a compartment accepts per slot before it answers 503 at once. */
const QUEUE_PER_SLOT = 4;
const QUEUE_TIMEOUT_MS = 15_000;

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class Compartment {
  active = 0;
  readonly waiters: Waiter[] = [];
}

function busy(): AppError {
  return new AppError(
    503,
    'CATEGORY_BUSY',
    'Prea multe operații simultane pentru această categorie. Reîncercați în câteva secunde.',
    { retryAfterMs: 2000 },
    retryAfter(2),
  );
}

/**
 * Bulkhead (TASKS P2.6): each category has its own pool of concurrent storage operations, sized by
 * the policy's `maxConcurrency` (read live, so a PUT /policies resizes it). A 10x storm of meter
 * readings fills only the meter compartment: fault records and videos keep their own slots. When a
 * compartment and its short queue are full, the request fails fast with 503 + Retry-After instead
 * of piling up memory. Per process: with N replicas the total is N x maxConcurrency.
 */
@Injectable()
export class BulkheadService {
  private readonly compartments = new Map<Category, Compartment>();

  async run<T>(category: Category, limit: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(category, Math.max(1, limit));
    try {
      return await fn();
    } finally {
      this.release(category, Math.max(1, limit));
    }
  }

  snapshot(): Record<string, { active: number; queued: number }> {
    return Object.fromEntries(
      [...this.compartments].map(([category, c]) => [
        category,
        { active: c.active, queued: c.waiters.length },
      ]),
    );
  }

  private compartment(category: Category): Compartment {
    let compartment = this.compartments.get(category);
    if (!compartment) {
      compartment = new Compartment();
      this.compartments.set(category, compartment);
    }
    return compartment;
  }

  private acquire(category: Category, limit: number): Promise<void> {
    const c = this.compartment(category);
    if (c.active < limit && c.waiters.length === 0) {
      c.active += 1;
      IN_FLIGHT.labels(category).set(c.active);
      return Promise.resolve();
    }
    if (c.waiters.length >= limit * QUEUE_PER_SLOT) {
      REJECTED.labels(category).inc();
      return Promise.reject(busy());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = c.waiters.indexOf(waiter);
          if (index >= 0) c.waiters.splice(index, 1);
          QUEUED.labels(category).set(c.waiters.length);
          REJECTED.labels(category).inc();
          reject(busy());
        }, QUEUE_TIMEOUT_MS),
      };
      c.waiters.push(waiter);
      QUEUED.labels(category).set(c.waiters.length);
    });
  }

  private release(category: Category, limit: number): void {
    const c = this.compartment(category);
    c.active -= 1;
    while (c.active < limit && c.waiters.length > 0) {
      const next = c.waiters.shift();
      if (!next) break;
      clearTimeout(next.timer);
      c.active += 1;
      next.resolve();
    }
    IN_FLIGHT.labels(category).set(c.active);
    QUEUED.labels(category).set(c.waiters.length);
  }
}
