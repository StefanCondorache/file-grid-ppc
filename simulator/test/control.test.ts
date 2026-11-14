import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Controller, MAX_DURATION_S, parseControlUpdate } from '../src/control.ts';
import type { ControlSnapshot } from '../src/control.ts';

function clock(start = Date.parse('2026-11-14T10:00:00Z')): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function controller(c = clock(), events: Array<[ControlSnapshot, string]> = []): Controller {
  return new Controller({
    normalRatePerS: 10,
    stormFactor: 10,
    maxRatePerS: 1000,
    now: c.now,
    onChange: (s, reason) => events.push([s, reason]),
  });
}

describe('PUT /control body validation', () => {
  const invalid: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [[], /JSON object/],
    ['peak', /JSON object/],
    [{}, /mode must be one of/],
    [{ mode: 'storm' }, /mode must be one of/],
    [{ mode: 'custom' }, /ratePerS is required/],
    [{ mode: 'custom', ratePerS: null }, /ratePerS is required/],
    [{ mode: 'custom', ratePerS: -1 }, /ratePerS must be >= 0/],
    [{ mode: 'custom', ratePerS: '50' }, /ratePerS must be a finite number/],
    [{ mode: 'peak', ratePerS: 'fast' }, /ratePerS must be a finite number/],
    [{ mode: 'peak', durationS: 0 }, /durationS must be > 0/],
    [{ mode: 'peak', durationS: MAX_DURATION_S + 1 }, /durationS must be > 0 and <= 3600/],
    [{ mode: 'peak', durationS: '60' }, /durationS must be a finite number/],
  ];
  for (const [body, message] of invalid) {
    it(`rejects ${JSON.stringify(body)}`, () => {
      const result = parseControlUpdate(body);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.message, message);
    });
  }

  it('accepts valid updates and drops fields that do not apply to the mode', () => {
    assert.deepEqual(parseControlUpdate({ mode: 'normal' }), { ok: true, value: { mode: 'normal' } });
    assert.deepEqual(parseControlUpdate({ mode: 'normal', durationS: 60 }), { ok: true, value: { mode: 'normal' } });
    assert.deepEqual(parseControlUpdate({ mode: 'peak', durationS: 3600, extra: 1 }), {
      ok: true,
      value: { mode: 'peak', durationS: 3600 },
    });
    assert.deepEqual(parseControlUpdate({ mode: 'peak', ratePerS: 5 }), { ok: true, value: { mode: 'peak' } });
    assert.deepEqual(parseControlUpdate({ mode: 'custom', ratePerS: 0 }), {
      ok: true,
      value: { mode: 'custom', ratePerS: 0 },
    });
    assert.deepEqual(parseControlUpdate({ mode: 'stopped', durationS: 1.5, ratePerS: null }), {
      ok: true,
      value: { mode: 'stopped', durationS: 1.5 },
    });
  });
});

describe('mode transitions', () => {
  it('starts in normal at METER_RATE with origin simulator', () => {
    const c = controller();
    assert.deepEqual(c.snapshot(), { mode: 'normal', ratePerS: 10, normalRatePerS: 10, peakRatePerS: 100, endsAt: null });
    assert.equal(c.origin(), 'simulator');
  });

  it('peak runs at METER_RATE x STORM_FACTOR with origin storm', () => {
    const c = controller();
    c.apply({ mode: 'peak' });
    assert.equal(c.ratePerS(), 100);
    assert.equal(c.origin(), 'storm');
  });

  it('caps peak and custom at MAX_RATE', () => {
    const t = clock();
    const c = new Controller({ normalRatePerS: 300, stormFactor: 10, maxRatePerS: 1000, now: t.now });
    c.apply({ mode: 'peak' });
    assert.equal(c.ratePerS(), 1000);
    c.apply({ mode: 'custom', ratePerS: 5000 });
    assert.equal(c.ratePerS(), 1000);
    c.apply({ mode: 'custom', ratePerS: 42.5 });
    assert.equal(c.ratePerS(), 42.5);
    assert.equal(c.origin(), 'simulator');
  });

  it('stopped generates nothing', () => {
    const c = controller();
    c.apply({ mode: 'stopped' });
    assert.equal(c.ratePerS(), 0);
  });

  it('returns to normal by itself when durationS runs out', () => {
    const t = clock();
    const events: Array<[ControlSnapshot, string]> = [];
    const c = controller(t, events);
    const snap = c.apply({ mode: 'peak', durationS: 60 });
    assert.equal(snap.endsAt, t.now() + 60_000);
    t.advance(59_999);
    assert.equal(c.mode, 'peak');
    t.advance(1);
    assert.equal(c.mode, 'normal');
    assert.equal(c.ratePerS(), 10);
    assert.equal(c.snapshot().endsAt, null);
    assert.deepEqual(
      events.map(([s, reason]) => [s.mode, reason]),
      [
        ['peak', 'update'],
        ['normal', 'expired'],
      ],
    );
  });

  it('a new update replaces a running timer; an untimed mode clears it', () => {
    const t = clock();
    const c = controller(t);
    c.apply({ mode: 'peak', durationS: 10 });
    c.apply({ mode: 'custom', ratePerS: 50, durationS: 30 });
    t.advance(20_000);
    assert.equal(c.mode, 'custom', 'the 10 s storm timer no longer applies');
    c.apply({ mode: 'stopped' });
    t.advance(3_600_000);
    assert.equal(c.mode, 'stopped');
    assert.equal(c.snapshot().endsAt, null);
  });
});
