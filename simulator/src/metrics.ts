// Minimal Prometheus registry (text exposition format 0.0.4), written by hand to keep zero dependencies.

import { ZONES } from './readings.ts';

export type Labels = Readonly<Record<string, string>>;

interface Sample {
  readonly labels: Labels;
  readonly value: number;
}

interface Collector {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge';
  samples(): readonly Sample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function checkName(name: string, labelNames: readonly string[]): void {
  if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name ${name}`);
  for (const label of labelNames) {
    if (!LABEL_NAME.test(label) || label.startsWith('__')) throw new Error(`invalid label name ${label}`);
  }
}

export class Counter implements Collector {
  readonly type = 'counter';
  readonly name: string;
  readonly help: string;
  readonly #labelNames: readonly string[];
  readonly #series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    checkName(name, labelNames);
    this.name = name;
    this.help = help;
    this.#labelNames = labelNames;
    if (labelNames.length === 0) this.#series.set('', { labels: {}, value: 0 });
  }

  #key(labels: Labels): { key: string; ordered: Labels } {
    const ordered: Record<string, string> = {};
    for (const name of this.#labelNames) {
      const value = labels[name];
      if (value === undefined) throw new Error(`${this.name}: missing label ${name}`);
      ordered[name] = value;
    }
    if (Object.keys(labels).length !== this.#labelNames.length) throw new Error(`${this.name}: unexpected labels`);
    return { key: JSON.stringify(Object.values(ordered)), ordered };
  }

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) throw new RangeError(`${this.name}: counters only go up`);
    const { key, ordered } = this.#key(labels);
    const current = this.#series.get(key);
    this.#series.set(key, { labels: ordered, value: (current?.value ?? 0) + by });
  }

  /** Creates the series at 0 so `increase()` sees the very first increment. */
  init(labels: Labels): void {
    this.inc(labels, 0);
  }

  get(labels: Labels = {}): number {
    return this.#series.get(this.#key(labels).key)?.value ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const { value } of this.#series.values()) sum += value;
    return sum;
  }

  samples(): readonly Sample[] {
    return [...this.#series.values()];
  }
}

export class Gauge implements Collector {
  readonly type = 'gauge';
  readonly name: string;
  readonly help: string;
  readonly #collect: () => readonly Sample[];

  constructor(name: string, help: string, collect: () => readonly Sample[]) {
    checkName(name, []);
    this.name = name;
    this.help = help;
    this.#collect = collect;
  }

  samples(): readonly Sample[] {
    return this.#collect();
  }
}

export class Registry {
  readonly #collectors: Collector[] = [];

  register<T extends Collector>(collector: T): T {
    if (this.#collectors.some((c) => c.name === collector.name)) throw new Error(`duplicate metric ${collector.name}`);
    this.#collectors.push(collector);
    return collector;
  }

  render(): string {
    const lines: string[] = [];
    for (const c of this.#collectors) {
      lines.push(`# HELP ${c.name} ${escapeHelp(c.help)}`, `# TYPE ${c.name} ${c.type}`);
      for (const s of c.samples()) lines.push(`${c.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const MODES = ['normal', 'peak', 'custom', 'stopped'] as const;
export type Mode = (typeof MODES)[number];

/** Live values read at scrape time for the gauges. */
export interface GaugeSource {
  ratePerS(): number;
  queueDepth(): number;
  mode(): Mode;
  backpressure(): boolean;
}

export interface SimMetrics {
  readonly registry: Registry;
  readonly readingsSent: Counter;
  readonly readingsAcked: Counter;
  readonly retries: Counter;
  readonly duplicatesSent: Counter;
  readonly readingsRejected: Counter;
  readonly requests: Counter;
  readonly backendDuplicates: Counter;
}

export function createSimMetrics(source: GaugeSource): SimMetrics {
  const registry = new Registry();
  const readingsSent = registry.register(
    new Counter(
      'filegrid_sim_readings_sent_total',
      'Unique meter readings sent for the first time (retries and deliberate duplicates excluded)',
      ['zone'],
    ),
  );
  const readingsAcked = registry.register(
    new Counter('filegrid_sim_readings_acked_total', 'Unique meter readings acknowledged by the backend (each id once)', [
      'zone',
    ]),
  );
  for (const zone of ZONES) {
    readingsSent.init({ zone });
    readingsAcked.init({ zone });
  }
  const retries = registry.register(
    new Counter('filegrid_sim_retries_total', 'Batch re-send attempts after a retryable failure (same reading ids)'),
  );
  const duplicatesSent = registry.register(
    new Counter('filegrid_sim_duplicates_sent_total', 'Already acknowledged readings re-sent on purpose'),
  );
  const readingsRejected = registry.register(
    new Counter('filegrid_sim_readings_rejected_total', 'Unique readings dropped because the backend rejected the batch (400/422)'),
  );
  const requests = registry.register(
    new Counter('filegrid_sim_requests_total', 'Requests to the backend by HTTP status (network = no response)', ['status']),
  );
  const backendDuplicates = registry.register(
    new Counter('filegrid_sim_backend_duplicates_total', 'Readings the backend reported as duplicates in 200 responses'),
  );
  registry.register(
    new Gauge('filegrid_sim_rate_per_second', 'Current reading generation rate', () => [{ labels: {}, value: source.ratePerS() }]),
  );
  registry.register(
    new Gauge('filegrid_sim_queue_depth', 'Readings generated but not yet acknowledged (queued plus in flight)', () => [
      { labels: {}, value: source.queueDepth() },
    ]),
  );
  registry.register(
    new Gauge('filegrid_sim_mode', 'Active simulator mode (1 for the active mode)', () =>
      MODES.map((mode) => ({ labels: { mode }, value: mode === source.mode() ? 1 : 0 })),
    ),
  );
  registry.register(
    new Gauge('filegrid_sim_backpressure', '1 while generation is paused because the queue is full', () => [
      { labels: {}, value: source.backpressure() ? 1 : 0 },
    ]),
  );
  return { registry, readingsSent, readingsAcked, retries, duplicatesSent, readingsRejected, requests, backendDuplicates };
}
