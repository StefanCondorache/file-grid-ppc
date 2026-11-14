import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Counter, Gauge, MODES, Registry, createSimMetrics, escapeLabelValue } from '../src/metrics.ts';
import type { Mode } from '../src/metrics.ts';

interface ParsedSample {
  readonly name: string;
  readonly labels: Record<string, string>;
  readonly value: number;
}

interface Parsed {
  readonly help: Map<string, string>;
  readonly types: Map<string, string>;
  readonly samples: ParsedSample[];
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"(,|$)/y;

function unescape(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** Strict-enough parser for the Prometheus text format: fails the test on any malformed line. */
function parseExposition(text: string): Parsed {
  assert.ok(text.endsWith('\n'), 'exposition ends with a newline');
  const parsed: Parsed = { help: new Map(), types: new Map(), samples: [] };
  for (const line of text.slice(0, -1).split('\n')) {
    const help = /^# HELP (\S+) (.*)$/.exec(line);
    const type = /^# TYPE (\S+) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (help) parsed.help.set(help[1] ?? '', help[2] ?? '');
    else if (type) parsed.types.set(type[1] ?? '', type[2] ?? '');
    else {
      const m = SAMPLE.exec(line);
      assert.ok(m, `malformed sample line: ${line}`);
      const labels: Record<string, string> = {};
      const raw = m[3] ?? '';
      LABEL.lastIndex = 0;
      while (LABEL.lastIndex < raw.length) {
        const l = LABEL.exec(raw);
        assert.ok(l, `malformed labels: ${raw}`);
        labels[l[1] ?? ''] = unescape(l[2] ?? '');
      }
      const name = m[1] ?? '';
      assert.ok(parsed.types.has(name), `${name} has a TYPE line before its samples`);
      const value = Number(m[4]);
      assert.ok(!Number.isNaN(value), `numeric value in: ${line}`);
      parsed.samples.push({ name, labels, value });
    }
  }
  return parsed;
}

describe('metrics exposition', () => {
  it('escapes label values (backslash, quote, newline)', () => {
    assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
    const registry = new Registry();
    const c = registry.register(new Counter('weird_total', 'help with \\ and\nnewline', ['v']));
    c.inc({ v: 'a"b\\c\nd' }, 2);
    const text = registry.render();
    assert.ok(text.includes('weird_total{v="a\\"b\\\\c\\nd"} 2'));
    assert.ok(text.includes('# HELP weird_total help with \\\\ and\\nnewline'));
    const parsed = parseExposition(text);
    assert.deepEqual(parsed.samples[0]?.labels, { v: 'a"b\\c\nd' });
  });

  it('renders every simulator metric with HELP and TYPE, zones pre-initialised at 0', () => {
    let mode: Mode = 'peak';
    const m = createSimMetrics({ ratePerS: () => 100, queueDepth: () => 42, mode: () => mode, backpressure: () => true });
    m.readingsSent.inc({ zone: 'banat' }, 3);
    m.requests.inc({ status: '200' });
    m.requests.inc({ status: 'network' });
    const parsed = parseExposition(m.registry.render());

    const expected: Record<string, string> = {
      filegrid_sim_readings_sent_total: 'counter',
      filegrid_sim_readings_acked_total: 'counter',
      filegrid_sim_retries_total: 'counter',
      filegrid_sim_duplicates_sent_total: 'counter',
      filegrid_sim_readings_rejected_total: 'counter',
      filegrid_sim_requests_total: 'counter',
      filegrid_sim_backend_duplicates_total: 'counter',
      filegrid_sim_rate_per_second: 'gauge',
      filegrid_sim_queue_depth: 'gauge',
      filegrid_sim_mode: 'gauge',
      filegrid_sim_backpressure: 'gauge',
    };
    for (const [name, type] of Object.entries(expected)) {
      assert.equal(parsed.types.get(name), type, name);
      assert.ok((parsed.help.get(name) ?? '').length > 0, `${name} has HELP`);
    }
    const value = (name: string, labels: Record<string, string> = {}) =>
      parsed.samples.find((s) => s.name === name && JSON.stringify(s.labels) === JSON.stringify(labels))?.value;

    assert.equal(value('filegrid_sim_readings_sent_total', { zone: 'banat' }), 3);
    assert.equal(value('filegrid_sim_readings_sent_total', { zone: 'muntenia' }), 0);
    assert.equal(value('filegrid_sim_readings_acked_total', { zone: 'dobrogea' }), 0);
    assert.equal(value('filegrid_sim_requests_total', { status: 'network' }), 1);
    assert.equal(value('filegrid_sim_rate_per_second'), 100);
    assert.equal(value('filegrid_sim_queue_depth'), 42);
    assert.equal(value('filegrid_sim_backpressure'), 1);
    for (const mm of MODES) assert.equal(value('filegrid_sim_mode', { mode: mm }), mm === 'peak' ? 1 : 0);

    mode = 'stopped';
    const again = parseExposition(m.registry.render());
    assert.equal(again.samples.filter((s) => s.name === 'filegrid_sim_mode' && s.value === 1)[0]?.labels.mode, 'stopped');
  });

  it('formats non-integer and special values', () => {
    const registry = new Registry();
    registry.register(new Gauge('g', 'gauge', () => [
      { labels: { k: 'frac' }, value: 2.5 },
      { labels: { k: 'nan' }, value: Number.NaN },
      { labels: { k: 'inf' }, value: Number.POSITIVE_INFINITY },
    ]));
    const text = registry.render();
    assert.ok(text.includes('g{k="frac"} 2.5\n'));
    assert.ok(text.includes('g{k="nan"} NaN\n'));
    assert.ok(text.includes('g{k="inf"} +Inf\n'));
  });

  it('counters refuse to go down and require their labels', () => {
    const c = new Counter('c_total', 'c', ['zone']);
    assert.throws(() => c.inc({ zone: 'banat' }, -1), RangeError);
    assert.throws(() => c.inc({}), /missing label zone/);
    assert.throws(() => c.inc({ zone: 'banat', extra: 'x' }), /unexpected labels/);
    assert.throws(() => new Counter('bad-name', 'x'), /invalid metric name/);
    const registry = new Registry();
    registry.register(new Counter('dup_total', 'x'));
    assert.throws(() => registry.register(new Counter('dup_total', 'x')), /duplicate metric/);
  });
});

describe('exposition of unlabelled metrics', () => {
  it('prints each unlabelled series exactly once after increments (Prometheus rejects duplicates)', async () => {
    const { createSimMetrics } = await import('../src/metrics.ts');
    const m = createSimMetrics({ queueDepth: () => 0, mode: () => 'normal', ratePerS: () => 1, backpressure: () => false });
    m.duplicatesSent.inc({}, 3);
    m.retries.inc();

    const text = m.registry.render();
    const lines = text.split('\n').filter((l) => l.startsWith('filegrid_sim_duplicates_sent_total'));

    assert.deepEqual(lines, ['filegrid_sim_duplicates_sent_total 3']);
  });
});
