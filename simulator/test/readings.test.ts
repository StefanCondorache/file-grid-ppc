import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANOMALY_RATIO,
  MeterFleet,
  ZONES,
  consumptionKwh,
  dailyProfile,
  localHour,
  meterId,
  seededRng,
  zoneCounts,
} from '../src/readings.ts';
import type { Reading, Zone } from '../src/readings.ts';

const START = Date.parse('2026-11-14T10:00:00Z');

function generate(fleet: MeterFleet, n: number): Reading[] {
  return Array.from({ length: n }, (_, i) => fleet.next(START + i * 100, 'simulator'));
}

describe('meter ids and reading ids', () => {
  it('formats meter ids per zone with six digits', () => {
    assert.equal(meterId('muntenia', 123), 'RO-MUN-000123');
    assert.equal(meterId('banat', 45), 'RO-BAN-000045');
    assert.equal(meterId('dobrogea', 7), 'RO-DOB-000007');
  });

  it('gives every reading a unique id "<meterId>:<sequence>"', () => {
    const fleet = new MeterFleet({ meterCount: 300, sequenceBase: 1, rng: seededRng(1) });
    const readings = generate(fleet, 30_000);
    const ids = new Set(readings.map((r) => r.readingId));
    assert.equal(ids.size, readings.length);
    for (const r of readings) {
      assert.match(r.readingId, /^RO-(MUN|BAN|DOB)-\d{6}:\d+$/);
      assert.equal(r.readingId, `${r.meterId}:${r.sequence}`);
    }
  });

  it('increases each meter sequence by one per reading, starting at the base', () => {
    const base = 1_763_114_400_000;
    const fleet = new MeterFleet({ meterCount: 50, sequenceBase: base, rng: seededRng(2) });
    const last = new Map<string, number>();
    for (const r of generate(fleet, 5000)) {
      const previous = last.get(r.meterId);
      assert.equal(r.sequence, previous === undefined ? base : previous + 1, r.readingId);
      last.set(r.meterId, r.sequence);
    }
    assert.equal(last.size, 50);
  });

  it('keeps ids unique across a restart when the base is the startup time', () => {
    const first = new MeterFleet({ meterCount: 10, sequenceBase: START, rng: seededRng(3) });
    const before = generate(first, 1000); // 100 readings per meter in 100 s
    const second = new MeterFleet({ meterCount: 10, sequenceBase: START + 100_000, rng: seededRng(3) });
    const after = generate(second, 1000);
    const ids = new Set([...before, ...after].map((r) => r.readingId));
    assert.equal(ids.size, 2000);
  });

  it('stamps readingTime as ISO and carries the origin', () => {
    const fleet = new MeterFleet({ meterCount: 3, sequenceBase: 1, rng: seededRng(4) });
    const r = fleet.next(START, 'storm');
    assert.equal(r.readingTime, '2026-11-14T10:00:00.000Z');
    assert.equal(r.origin, 'storm');
  });
});

describe('zone distribution', () => {
  it('splits meters 50/30/20 and the counts always add up', () => {
    assert.deepEqual(zoneCounts(300), { muntenia: 150, banat: 90, dobrogea: 60 });
    for (const total of [1, 2, 3, 7, 11, 299, 1001]) {
      const c = zoneCounts(total);
      assert.equal(c.muntenia + c.banat + c.dobrogea, total, `total ${total}`);
    }
  });

  it('spreads readings over the zones in the same proportion, with matching id prefixes', () => {
    const fleet = new MeterFleet({ meterCount: 300, sequenceBase: 1, rng: seededRng(5) });
    const counts: Record<Zone, number> = { muntenia: 0, banat: 0, dobrogea: 0 };
    const prefix: Record<Zone, string> = { muntenia: 'RO-MUN-', banat: 'RO-BAN-', dobrogea: 'RO-DOB-' };
    for (const r of generate(fleet, 3000)) {
      counts[r.zone] += 1;
      assert.ok(r.meterId.startsWith(prefix[r.zone]), r.meterId);
    }
    assert.deepEqual(counts, { muntenia: 1500, banat: 900, dobrogea: 600 });
  });

  it('interleaves zones instead of sending one zone after another', () => {
    const fleet = new MeterFleet({ meterCount: 300, sequenceBase: 1, rng: seededRng(6) });
    const firstHundred = new Set(generate(fleet, 100).map((r) => r.zone));
    assert.deepEqual([...firstHundred].sort(), [...ZONES].sort());
  });
});

describe('consumption', () => {
  it('is never negative, always finite and has at most 3 decimals', () => {
    const fleet = new MeterFleet({ meterCount: 300, sequenceBase: 1, rng: seededRng(7) });
    for (let i = 0; i < 100_000; i += 1) {
      const r = fleet.next(START + i * 1000, 'simulator');
      assert.ok(Number.isFinite(r.kwh) && r.kwh >= 0, `kwh ${r.kwh}`);
      assert.equal(Math.round(r.kwh * 1000) / 1000, r.kwh);
    }
  });

  it('has evening and morning peaks above the night trough', () => {
    const night = dailyProfile(3.5);
    assert.ok(dailyProfile(19.5) > dailyProfile(7.5));
    assert.ok(dailyProfile(7.5) > dailyProfile(13) && dailyProfile(13) > night);
    assert.ok(dailyProfile(23.9) > 0 && Math.abs(dailyProfile(0) - dailyProfile(24)) < 1e-9);
  });

  it('stays in a realistic 15-minute range for a household, with rare anomalies', () => {
    const rng = seededRng(8);
    const values = Array.from({ length: 200_000 }, () => consumptionKwh(0.3, 19.5, rng));
    const median = [...values].sort((a, b) => a - b)[values.length / 2] ?? 0;
    assert.ok(median > 0.1 && median < 0.25, `median ${median}`); // 0.3 kW x ~2.6 profile x 0.25 h ~ 0.2 kWh
    const zeros = values.filter((v) => v === 0).length / values.length;
    const spikes = values.filter((v) => v > median * 3.5).length / values.length;
    assert.ok(Math.abs(zeros - ANOMALY_RATIO / 2) < 0.001, `zeros ${zeros}`);
    assert.ok(Math.abs(spikes - ANOMALY_RATIO / 2) < 0.001, `spikes ${spikes}`);
  });

  it('uses Romanian local time for the daily profile', () => {
    assert.equal(localHour(Date.parse('2026-11-14T17:30:00Z')), 19.5); // EET = UTC+2 in November
    assert.equal(localHour(Date.parse('2026-07-01T04:00:00Z')), 7); // EEST = UTC+3 in summer
  });
});
