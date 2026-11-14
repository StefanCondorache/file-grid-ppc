import { Counter, Gauge, Histogram, register } from 'prom-client';

/**
 * Application metrics on prom-client's default registry (exposed at /metrics with the storage
 * metrics). Names, labels and outcome values are the contract in the README ("Metrici așteptate de
 * dashboard și alerte"): dashboards and alert rules in deploy/k8s/observability depend on them.
 * outcome: success | duplicate | mismatch | rejected | error  (success/ok/duplicate = success).
 */

function metric<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

export const UPLOADS_TOTAL = metric(
  'filegrid_uploads_total',
  () =>
    new Counter({
      name: 'filegrid_uploads_total',
      help: 'Finished uploads (file confirmed or refused) per category and outcome.',
      labelNames: ['category', 'outcome'],
    }),
);

export const UPLOAD_DURATION = metric(
  'filegrid_upload_duration_seconds',
  () =>
    new Histogram({
      name: 'filegrid_upload_duration_seconds',
      help: 'Upload complete -> file durable and listable, per category and outcome.',
      labelNames: ['category', 'outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
    }),
);

export const DOWNLOADS_TOTAL = metric(
  'filegrid_downloads_total',
  () =>
    new Counter({
      name: 'filegrid_downloads_total',
      help: 'File downloads per category and outcome (success, corrupt, error).',
      labelNames: ['category', 'outcome'],
    }),
);

export const INTEGRITY_FAILURES = metric(
  'filegrid_integrity_failures_total',
  () =>
    new Counter({
      name: 'filegrid_integrity_failures_total',
      help: 'Stored objects whose SHA-256 no longer matched (corruption detected).',
      labelNames: ['category', 'storage'],
    }),
);

export const METER_STORED = metric(
  'filegrid_meter_readings_stored_total',
  () =>
    new Counter({
      name: 'filegrid_meter_readings_stored_total',
      help: 'Meter readings stored for the first time.',
      labelNames: ['zone'],
    }),
);

export const METER_DUPLICATES = metric(
  'filegrid_meter_readings_duplicates_total',
  () =>
    new Counter({
      name: 'filegrid_meter_readings_duplicates_total',
      help: 'Retried or duplicated meter readings recognised by reading_id and not stored again.',
      labelNames: ['zone'],
    }),
);

export const METER_DUPLICATE_STORED = metric(
  'filegrid_meter_readings_duplicate_stored_total',
  () =>
    new Counter({
      name: 'filegrid_meter_readings_duplicate_stored_total',
      help: 'Meter readings stored twice. Must stay 0 (the primary key on reading_id forbids it).',
    }),
);

export const METER_BATCHES = metric(
  'filegrid_meter_batches_total',
  () =>
    new Counter({
      name: 'filegrid_meter_batches_total',
      help: 'Meter reading batches per outcome (success, rejected, error).',
      labelNames: ['outcome'],
    }),
);

/**
 * Meter readings lost, as GET /guarantees computes it (sent - acked - queued, from the simulator),
 * set by the guarantee evaluator on the leader replica every GUARANTEE_EVAL_INTERVAL_S. 0 when
 * nothing is lost and on the other replicas; NaN while the loss is unknown (simulator unreachable).
 * The MeterReadingsLost alert (> 0 for 2m) and the dashboard's "Pierdute" stat read only this.
 */
export const METER_READINGS_LOST = metric(
  'filegrid_meter_readings_lost',
  () =>
    new Gauge({
      name: 'filegrid_meter_readings_lost',
      help: 'Meter readings lost (sent - acked - queued), from the guarantee evaluator; NaN when unknown.',
    }),
);

/** Touch every label combination once so dashboards show 0 instead of "no data". */
export function initAppMetrics(categories: readonly string[], zones: readonly string[]): void {
  METER_DUPLICATE_STORED.inc(0);
  for (const zone of zones) {
    METER_STORED.labels(zone).inc(0);
    METER_DUPLICATES.labels(zone).inc(0);
  }
  for (const category of categories) {
    UPLOADS_TOTAL.labels(category, 'success').inc(0);
    DOWNLOADS_TOTAL.labels(category, 'success').inc(0);
  }
}
