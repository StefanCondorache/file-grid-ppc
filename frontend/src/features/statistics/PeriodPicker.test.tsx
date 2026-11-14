import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Period } from './contract';
import { PeriodPicker, pickPeriods } from './PeriodPicker';

const period = (id: string, kind: Period['kind'], label: string, start: string): Period => ({
  id, label, kind, origin: kind === 'peak' ? 'storm' : 'seed', start, end: null,
});

/** Newest first, as the API lists them. */
const PERIODS: Period[] = [
  period('p-storm-14', 'peak', 'Furtună · 14 nov 15:33', '2026-11-14T13:33:00.000Z'),
  period('p-normal-13', 'normal', 'Zi normală · 13 nov', '2026-11-12T22:00:00.000Z'),
  period('p-normal-12', 'normal', 'Zi normală · 12 nov', '2026-11-11T22:00:00.000Z'),
  period('p-storm-10', 'peak', 'Furtună · 10 nov 08:00', '2026-11-10T06:00:00.000Z'),
];

describe('PeriodPicker', () => {
  it('defaults to the newest normal period (A) vs the most recent peak (B), whatever the list order', () => {
    expect(pickPeriods([...PERIODS].reverse(), {})).toEqual({ a: 'p-normal-13', b: 'p-storm-14' });
  });

  it('keeps a requested period that exists and falls back for one that does not', () => {
    expect(pickPeriods(PERIODS, { a: 'p-normal-12', b: 'p-gone' })).toEqual({ a: 'p-normal-12', b: 'p-storm-14' });
    expect(pickPeriods(PERIODS.filter((p) => p.kind === 'normal'), {})).toEqual({ a: 'p-normal-13', b: null });
    expect(pickPeriods([], { a: 'p-normal-12' })).toEqual({ a: null, b: null });
  });

  it('offers every period under A and B, grouped by kind, and reports the new pair', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PeriodPicker periods={PERIODS} value={{ a: 'p-normal-13', b: 'p-storm-14' }} onChange={onChange} />);
    const a = screen.getByLabelText('Perioada A');
    const b = screen.getByLabelText('Perioada B');
    expect(a).toHaveDisplayValue('Zi normală · 13 nov');
    expect(b).toHaveDisplayValue('Furtună · 14 nov 15:33');
    expect(within(a).getAllByRole('option')).toHaveLength(4);
    expect(within(b).getAllByRole('group').map((g) => g.getAttribute('label'))).toEqual(['Zile normale', 'Zile de vârf']);

    await user.selectOptions(b, 'Furtună · 10 nov 08:00');
    expect(onChange).toHaveBeenLastCalledWith({ a: 'p-normal-13', b: 'p-storm-10' });
    await user.selectOptions(a, 'Zi normală · 12 nov');
    expect(onChange).toHaveBeenLastCalledWith({ a: 'p-normal-12', b: 'p-storm-14' });
  });

  it('says so when there are no labelled periods yet', () => {
    render(<PeriodPicker periods={[]} value={{ a: null, b: null }} onChange={vi.fn()} />);
    expect(screen.getByText('Nu există încă perioade etichetate.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Perioada A')).toBeNull();
  });
});
