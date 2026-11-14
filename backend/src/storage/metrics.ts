import { AsyncLocalStorage } from 'node:async_hooks';
import { Counter, Gauge, Histogram, register } from 'prom-client';

/**
 * Prometheus metrics for the storage layer: the contract the Grafana dashboards and alert rules in
 * `deploy/k8s/observability/` are built on (port of P1's `metrics.py`; same names, labels, buckets).
 * Everything is registered on prom-client's default `register`, which the app serves at /metrics.
 *
 * `filegrid_storage_operation_seconds` (histogram): storage (s3|ftp|db), operation
 *   (put|get|delete|health), category, outcome (ok|error|rejected). Covers the whole stream for
 *   put/get; `rejected` = refused instantly by an open circuit breaker. Downloads the consumer
 *   stops early are not observed.
 * `filegrid_storage_bytes_total` (counter): storage, operation (put|get), category. Incremented
 *   while streaming.
 * `filegrid_storage_errors_total` (counter): storage, operation, category, error_type. One per
 *   failed or rejected operation. error_type is CircuitOpen, IdleTimeout, Timeout, ObjectNotFound,
 *   IntegrityError, InvalidKey, StorageBusy (no free pooled connection), SourceError (the caller's
 *   input failed), HealthCheckFailed, or the
 *   underlying error (a Node error code such as ECONNREFUSED, else the error class name).
 *   Health probes use category "system".
 * `filegrid_storage_up` (gauge): storage. 1 if the last health probe succeeded, else 0.
 * `filegrid_storage_circuit_state` (gauge): storage. 0 closed, 1 half-open, 2 open.
 *
 * The category comes from an AsyncLocalStorage set per request or job:
 *
 *     await withCategory('fault_records', () => storage.putStream(key, chunks));
 *
 * It is captured when an operation starts (`getStream` captures it when called, not when
 * iterated). Labels must match `[a-z][a-z0-9_]{0,39}`; anything else is reported as `invalid`.
 */

export const DEFAULT_CATEGORY = 'unknown';
export const INVALID_CATEGORY = 'invalid';
export const SYSTEM_CATEGORY = 'system';
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];

const categoryStore = new AsyncLocalStorage<string>();

/** A safe `category` label for `value`. */
export function categoryLabel(value: string): string {
  return CATEGORY_PATTERN.test(value) ? value : INVALID_CATEGORY;
}

/** The category label of the current async context (`unknown` outside `withCategory`). */
export function currentCategory(): string {
  return categoryLabel(categoryStore.getStore() ?? DEFAULT_CATEGORY);
}

/** Run `fn` with `category` as the metrics category of every storage operation it starts. */
export function withCategory<T>(category: string, fn: () => T): T {
  return categoryStore.run(category, fn);
}

function reuse<T>(name: string, create: () => T): T {
  // Tests and hot reloads may load this module twice against the same registry.
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

type OperationLabels = 'storage' | 'operation' | 'category' | 'outcome';
type BytesLabels = 'storage' | 'operation' | 'category';
type ErrorLabels = 'storage' | 'operation' | 'category' | 'error_type';

export const OPERATION_SECONDS = reuse(
  'filegrid_storage_operation_seconds',
  () =>
    new Histogram<OperationLabels>({
      name: 'filegrid_storage_operation_seconds',
      help: 'Duration of a storage operation (whole stream for put/get).',
      labelNames: ['storage', 'operation', 'category', 'outcome'],
      buckets: BUCKETS,
    }),
);

export const BYTES_TOTAL = reuse(
  'filegrid_storage_bytes_total',
  () =>
    new Counter<BytesLabels>({
      name: 'filegrid_storage_bytes_total',
      help: 'Bytes written (put) or read (get) per storage and category.',
      labelNames: ['storage', 'operation', 'category'],
    }),
);

export const ERRORS_TOTAL = reuse(
  'filegrid_storage_errors_total',
  () =>
    new Counter<ErrorLabels>({
      name: 'filegrid_storage_errors_total',
      help: 'Failed or rejected storage operations.',
      labelNames: ['storage', 'operation', 'category', 'error_type'],
    }),
);

export const STORAGE_UP = reuse(
  'filegrid_storage_up',
  () =>
    new Gauge<'storage'>({
      name: 'filegrid_storage_up',
      help: '1 if the last health probe of the storage succeeded, else 0.',
      labelNames: ['storage'],
    }),
);

export const CIRCUIT_STATE = reuse(
  'filegrid_storage_circuit_state',
  () =>
    new Gauge<'storage'>({
      name: 'filegrid_storage_circuit_state',
      help: 'Circuit breaker state per storage: 0 closed, 1 half-open, 2 open.',
      labelNames: ['storage'],
    }),
);

/** Reset every storage metric (tests). */
export function resetStorageMetrics(): void {
  for (const metric of [OPERATION_SECONDS, BYTES_TOTAL, ERRORS_TOTAL, STORAGE_UP, CIRCUIT_STATE]) {
    metric.reset();
  }
}
