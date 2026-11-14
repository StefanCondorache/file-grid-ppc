'use client';

import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import type { MeterCounters as MeterCountersData } from '@/lib/monitoring/contract';

type Counter = 'received' | 'unique' | 'duplicatesRejected' | 'lost';
export type CounterValues = { [K in Counter]: MeterCountersData[K] | null };

const ORDER: readonly Counter[] = ['received', 'unique', 'duplicatesRejected', 'lost'];

/**
 * The meter-readings proof (no reading lost or duplicated) as label/number rows. Never a live region: the numbers
 * tick every couple of seconds and would flood a screen reader (A11Y-17); the guarantee card announces a loss.
 */
export function MeterCounters({ counters, className }: { counters: CounterValues; className?: string }) {
  const t = useT().monitoring.counters;
  return (
    <dl className={cn('flex flex-col', className)}>
      {ORDER.map((key) => {
        const value = counters[key];
        const lost = key === 'lost';
        return (
          <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border py-1 last:border-b-0">
            <dt className="text-[15px] text-ink-2">{t[key]}</dt>
            <dd
              className={cn(
                'text-right font-bold tracking-tight tabular-nums',
                lost ? 'text-[30px] leading-tight' : 'text-2xl',
                lost && value === 0 && 'text-ok-ink',
                lost && value !== null && value > 0 && 'text-crit-ink',
                value === null && 'text-base font-semibold text-ink-2',
              )}
            >
              {value === null ? t.unknown : formatInt(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
