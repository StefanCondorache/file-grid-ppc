import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnnouncements, resetAnnouncer } from '@/lib/a11y/announcer';
import type { GuaranteeState, GuaranteeStatus } from '@/lib/monitoring/contract';
import { GuaranteeCard } from './GuaranteeCard';
import { MeterCounters } from './MeterCounters';
import { sentenceFor } from './sentences';

const NBSP = '\u00A0';
/** Match text as rendered: the default normalizer would turn the NBSP of Romanian numbers into spaces. */
const exact = { normalizer: (text: string) => text };

/** A fault-records guarantee as the mock (and the backend) sends it. */
function fault(state: GuaranteeState, p95Ms: number | null = 3400, targetMs = 2000): GuaranteeStatus {
  return {
    category: 'fault_records',
    state,
    causeCode: state === 'ok' ? null : 'FAULT_P95_ABOVE_TARGET',
    causeFacts: state === 'ok' ? {} : { p95Ms, targetMs, samples: 412, windowMinutes: 1 },
    metrics: [{ key: 'uploadToAvailableP95Ms', value: p95Ms === null ? null : String(p95Ms), unit: 'ms', threshold: String(targetMs), comparator: 'lte' }],
    updatedAt: '2026-11-14T13:33:00.000Z',
  };
}

function guarantee(category: GuaranteeStatus['category'], state: GuaranteeState, causeCode: string | null, causeFacts: Record<string, unknown>, metrics: [string, string | null, string?][] = []): GuaranteeStatus {
  return {
    category, state, causeCode, causeFacts, updatedAt: '2026-11-14T13:33:00.000Z',
    metrics: metrics.map(([key, value, threshold]) => ({ key, value, unit: null, threshold: threshold ?? null, comparator: null })),
  };
}

describe('sentenceFor', () => {
  it('says how fast faults reach dispatch, against the target', () => {
    expect(sentenceFor(fault('at_risk', 3400))).toBe(`Avariile ajung la dispecerat în 3,4${NBSP}s, peste ținta de 2${NBSP}s.`);
    expect(sentenceFor(fault('ok', 600))).toBe(`Avariile ajung la dispecerat în 0,6${NBSP}s, sub ținta de 2${NBSP}s.`);
    // The backend's at-risk cause: above 80 % of a 5 s target, read from causeFacts.
    const near = { ...fault('at_risk', 4200, 5000), causeCode: 'FAULT_P95_NEAR_TARGET' };
    expect(sentenceFor(near)).toBe(`Avariile ajung la dispecerat în 4,2${NBSP}s, aproape de ținta de 5${NBSP}s.`);
    expect(sentenceFor(fault('ok', null))).toBe(`Nicio avarie încărcată recent; ținta este de 2${NBSP}s până la dispecerat.`);
  });

  it('has a Romanian sentence for every cause code of the backend', () => {
    expect(sentenceFor(guarantee('meter_readings', 'ok', null, {}, [['lost', '0', '0']]))).toBe('Nicio citire pierdută sau dublată.');
    expect(sentenceFor(guarantee('meter_readings', 'violated', 'METER_READINGS_LOST', { lost: 3, max: 0 }))).toBe('3 citiri pierdute; trebuie să fie 0.');
    expect(sentenceFor(guarantee('meter_readings', 'at_risk', 'METER_LOSS_UNKNOWN', {}))).toBe('Simulatorul nu răspunde: nu putem confirma că nu s-a pierdut nicio citire.');
    expect(sentenceFor(guarantee('connection_documents', 'ok', null, {}))).toBe('Datele personale sunt criptate și fiecare acces este auditat.');
    expect(sentenceFor(guarantee('connection_documents', 'violated', 'CONNECTION_NOT_ENCRYPTED', { encryptedPct: 98.5, unencrypted: 3, minPct: 100 })))
      .toBe(`Doar 98,5${NBSP}% din documentele de racordare sunt criptate; ținta este 100${NBSP}%.`);
    expect(sentenceFor(guarantee('connection_documents', 'at_risk', 'CONNECTION_UNMASK_SPIKE', { unmaskEventsToday: 25, max: 20 })))
      .toBe('Datele personale au fost afișate de 25 de ori azi, peste limita de 20.');
    expect(sentenceFor(guarantee('drone_videos', 'ok', null, {}))).toBe('Transferurile mari se termină și pe rețea instabilă.');
    expect(sentenceFor(guarantee('drone_videos', 'violated', 'DRONE_SUCCESS_BELOW_TARGET', { successRate: 0.9, min: 0.95, failed: 2, completed: 18 })))
      .toBe(`Doar 90${NBSP}% din transferurile video s-au încheiat cu succes, sub ținta de 95${NBSP}%.`);
    expect(sentenceFor(guarantee('drone_videos', 'at_risk', 'DRONE_SUCCESS_NEAR_TARGET', { successRate: 0.975, min: 0.95, failed: 1, completed: 39 })))
      .toBe(`97,5${NBSP}% din transferurile video s-au încheiat cu succes, aproape de pragul minim de 95${NBSP}%.`);
  });

  it('falls back to the state when the cause is unknown', () => {
    expect(sentenceFor(guarantee('drone_videos', 'at_risk', 'SOMETHING_NEW', {}))).toBe('Garanția este în pericol.');
    expect(sentenceFor(guarantee('connection_documents', 'violated', 'SOMETHING_NEW', {}))).toBe('Garanția este încălcată.');
  });
});

describe('GuaranteeCard', () => {
  it.each([
    ['ok', 'OK', 'ok'],
    ['at_risk', 'În pericol', 'warn'],
    ['violated', 'Încălcat', 'crit'],
  ] as const)('renders the %s state as text, icon and chip', (state, word, tone) => {
    const g = fault(state, state === 'ok' ? 600 : 3400);
    render(<GuaranteeCard guarantee={g} />);
    const card = screen.getByRole('article', { name: 'Avarii' });
    expect(card).toHaveAttribute('data-state', state);
    const chip = within(card).getByText(word).closest('[data-tone]');
    expect(chip).toHaveAttribute('data-tone', tone);
    expect(chip?.className).toContain('rounded-chip');
    expect(chip?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(card).getByText(sentenceFor(g), exact)).toBeInTheDocument();
    expect(within(card).getByText(`țintă ≤ 2${NBSP}s`, exact)).toBeInTheDocument();
  });

  it('gives the at-risk card the 6 px status edge, and the OK card none', () => {
    const { rerender } = render(<GuaranteeCard guarantee={fault('ok', 600)} />);
    expect(screen.getByRole('article').querySelector('[data-status-edge]')).toBeNull();
    rerender(<GuaranteeCard guarantee={fault('at_risk')} />);
    const edge = screen.getByRole('article').querySelector('[data-status-edge]');
    expect(edge).toHaveClass('w-[6px]');
    expect(edge).toHaveAttribute('aria-hidden', 'true');
  });

  describe('announcements', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetAnnouncer();
    });
    afterEach(() => vi.useRealTimers());

    it('announces a status change politely and a violation assertively, never on mount', () => {
      const { rerender } = render(<GuaranteeCard guarantee={fault('ok', 600)} />);
      act(() => vi.advanceTimersByTime(5_000));
      expect(getAnnouncements().polite.count + getAnnouncements().assertive.count).toBe(0);

      rerender(<GuaranteeCard guarantee={fault('at_risk')} />);
      act(() => vi.advanceTimersByTime(3_000));
      expect(getAnnouncements().polite.text).toBe('Garanția Avarii: În pericol');
      expect(getAnnouncements().assertive.count).toBe(0);

      rerender(<GuaranteeCard guarantee={fault('violated', 4600)} />);
      act(() => vi.advanceTimersByTime(3_000));
      expect(getAnnouncements().assertive.text).toBe('Garanția Avarii: Încălcat');
    });

    it('debounces flapping by 3 s', () => {
      const { rerender } = render(<GuaranteeCard guarantee={fault('ok', 600)} />);
      rerender(<GuaranteeCard guarantee={fault('at_risk')} />);
      act(() => vi.advanceTimersByTime(1_000));
      rerender(<GuaranteeCard guarantee={fault('ok', 700)} />);
      act(() => vi.advanceTimersByTime(5_000));
      expect(getAnnouncements().polite.count + getAnnouncements().assertive.count).toBe(0);
    });
  });
});

describe('MeterCounters', () => {
  /** The number on the same row as a label (`<dt>` label, `<dd>` number). */
  const valueOf = (label: string) => {
    const term = screen.getByText(label);
    expect(term.tagName).toBe('DT');
    return term.nextElementSibling;
  };

  it('renders the counters as label/number rows, ending with pierdute (trebuie 0)', () => {
    render(<MeterCounters counters={{ received: 1_284_532, unique: 1_258_841, duplicatesRejected: 25_691, lost: 0 }} />);
    expect(screen.getAllByRole('term').map((dt) => dt.textContent)).toEqual(['primite', 'unice', 'duplicate respinse', 'pierdute (trebuie 0)']);
    expect(valueOf('primite')?.textContent).toBe(`1${NBSP}284${NBSP}532`);
    expect(valueOf('duplicate respinse')?.textContent).toBe(`25${NBSP}691`);
    expect(valueOf('pierdute (trebuie 0)')?.textContent).toBe('0');
    expect(valueOf('pierdute (trebuie 0)')?.tagName).toBe('DD');
  });

  it('says necunoscut when the simulator cannot report losses', () => {
    render(<MeterCounters counters={{ received: 10, unique: 10, duplicatesRejected: 0, lost: null }} />);
    expect(valueOf('pierdute (trebuie 0)')?.textContent).toBe('necunoscut');
  });

  it('is what the meter readings card shows, fed by the guarantee metrics', () => {
    const meter = guarantee('meter_readings', 'ok', null, {}, [['received', '1284532'], ['unique', '1258841'], ['duplicatesRejected', '25691'], ['lost', '0', '0']]);
    render(<GuaranteeCard guarantee={meter} />);
    const card = screen.getByRole('article', { name: 'Citiri contoare' });
    expect(within(card).getByText('Nicio citire pierdută sau dublată.')).toBeInTheDocument();
    expect(valueOf('primite')?.textContent).toBe(`1${NBSP}284${NBSP}532`);
    expect(valueOf('pierdute (trebuie 0)')?.textContent).toBe('0');
  });
});
