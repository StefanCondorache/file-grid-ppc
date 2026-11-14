'use client';

import { useId } from 'react';
import { useT } from '@/lib/i18n';
import type { Period } from './contract';

/** The two compared periods by id: A is meant to be a normal day, B a peak. null while no such period exists. */
export type PeriodChoice = { a: string | null; b: string | null };

const KINDS: readonly Period['kind'][] = ['normal', 'peak'];
const startMs = (p: Period) => Date.parse(p.start);

function newest(periods: readonly Period[], kind: Period['kind']): Period | null {
  return periods.filter((p) => p.kind === kind).reduce<Period | null>((best, p) => (!best || startMs(p) > startMs(best) ? p : best), null);
}

/**
 * FE-12: a requested period wins when the list has it; otherwise A is the newest normal period and B the most recent
 * peak. The real backend needs both ids for the comparison, so the screen picks the default pair itself.
 */
export function pickPeriods(periods: readonly Period[], requested: { a?: string | null; b?: string | null }): PeriodChoice {
  const listed = (id: string | null | undefined) => (id && periods.some((p) => p.id === id) ? id : null);
  return {
    a: listed(requested.a) ?? newest(periods, 'normal')?.id ?? null,
    b: listed(requested.b) ?? newest(periods, 'peak')?.id ?? null,
  };
}

type Props = { periods: readonly Period[]; value: PeriodChoice; onChange: (next: PeriodChoice) => void };

/** Two labelled native selects, A and B, each listing every labelled period grouped by kind, newest first. */
export function PeriodPicker({ periods, value, onChange }: Props) {
  const t = useT();
  if (periods.length === 0) return <p className="text-sm text-ink-2">{t.statistics.periods.none}</p>;
  return (
    <fieldset className="m-0 flex flex-wrap items-end gap-3 border-0 p-0">
      <legend className="sr-only">{t.statistics.periods.legend}</legend>
      <PeriodSelect label={t.statistics.periods.a} periods={periods} value={value.a} onSelect={(a) => onChange({ ...value, a })} />
      <PeriodSelect label={t.statistics.periods.b} periods={periods} value={value.b} onSelect={(b) => onChange({ ...value, b })} />
    </fieldset>
  );
}

function PeriodSelect({ label, periods, value, onSelect }: { label: string; periods: readonly Period[]; value: string | null; onSelect: (id: string) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink-2">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        className="h-10 max-w-full min-w-56 rounded-control border-[1.5px] border-input bg-surface px-3 text-sm font-semibold text-ink"
      >
        {value === null && (
          <option value="" disabled>
            {t.statistics.periods.choose}
          </option>
        )}
        {KINDS.map((kind) => {
          const ofKind = periods.filter((p) => p.kind === kind).sort((x, y) => startMs(y) - startMs(x));
          return ofKind.length === 0 ? null : (
            <optgroup key={kind} label={t.statistics.periods.group[kind]}>
              {ofKind.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}
