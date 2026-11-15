'use client';

import { useId, type ReactNode } from 'react';
import type { ChartColumn } from '@/components/charts/ChartTable';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { plural, useT } from '@/lib/i18n';
import { formatBytes, formatInt, formatPercent } from '@/lib/i18n/format';
import {
  COMPARISON_METRICS,
  STATS_CATEGORIES,
  type ComparisonMetric,
  type ComparisonRow,
  type PeriodComparison as PeriodComparisonData,
  type StatsCategoryId,
} from './contract';
import { Insight } from './Insight';
import { formatDelta, formatLatency, interpretS2 } from './interpret';
import { usePeriodComparison, usePeriods } from './queries';
import { CATEGORY_FILL } from './StorageFit';
import { TableDetails } from './TableDetails';

const NBSP = ' ';
/** Tick steps in ms; the axis takes the smallest one that reaches the slowest p95 in at most `MAX_STEPS` steps. */
const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000] as const;
const MAX_STEPS = 5;

/** One axis for every category, from 0 to a round value at or above `maxMs` (3,4 s → 0–4 s, ticks every second). */
export function axisScale(maxMs: number): { max: number; ticks: number[] } {
  const step = STEPS.find((s) => maxMs <= s * MAX_STEPS) ?? Math.ceil(maxMs / MAX_STEPS / 60_000) * 60_000;
  const count = Math.max(1, Math.ceil(maxMs / step));
  return { max: count * step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
}

const seconds = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
/** Axis labels share one unit: seconds once the axis reaches 1 s ("0 s", "1 s", "2,5 s"), milliseconds below. */
function tickLabel(ms: number, max: number): string {
  return max >= 1_000 ? `${seconds.format(ms / 1_000).replace(/\./g, NBSP)}${NBSP}s` : `${formatInt(ms)}${NBSP}ms`;
}

/** Where a value sits on the axis, in % of its length. */
const at = (ms: number, max: number) => Math.min(100, Math.round((ms / max) * 1_000) / 10);

const unitOf = (text: string) => text.slice(text.lastIndexOf(NBSP) + 1);
/** "0,6 → 3,4 s" when both share a unit, "90 ms → 0,12 s" when not, a dash for a period without measurements. */
function pair(a: number | null, b: number | null): string {
  const from = a === null ? '—' : formatLatency(a);
  const to = b === null ? '—' : formatLatency(b);
  const shared = a !== null && b !== null && unitOf(from) === unitOf(to);
  return `${shared ? from.slice(0, from.lastIndexOf(NBSP)) : from} → ${to}`;
}

const rate = new Intl.NumberFormat('ro-RO', { maximumSignificantDigits: 3 });
/** Operations per second: whole from 100 up, otherwise 3 significant digits ("52", "0,1", "0,0005"). */
const formatRate = (n: number) => (n >= 100 ? formatInt(n) : rate.format(n));

/** S2 · "Zi normală vs. zi de vârf" (FE-10, beat 8) for the two chosen periods, with its waiting, loading and error states. */
export function PeriodComparison({ a, b }: { a: string | null; b: string | null }) {
  const t = useT();
  const titleId = useId();
  const periods = usePeriods();
  const cmp = usePeriodComparison(a, b);
  const s = t.statistics.comparison;
  let body: ReactNode;
  if (a === null || b === null) body = periods.isPending ? <Loading /> : <EmptyState title={s.waiting} body={s.waitingBody} />;
  else if (cmp.isPending) body = <Loading />;
  else if (cmp.isError) body = <ErrorState error={cmp.error} onRetry={() => void cmp.refetch()} />;
  else body = <PeriodComparisonView cmp={cmp.data} />;

  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <h2 id={titleId} className="text-[22px] font-bold">
          {s.title}
        </h2>
      </header>
      {body}
    </Card>
  );
}

const SKELETON = [0, 1, 2, 3] as const;

function Loading() {
  const t = useT();
  return (
    <div role="status">
      <span className="sr-only">{t.common.loading}</span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {SKELETON.map((i) => (
          <div key={i} className="h-9 skeleton rounded-panel bg-surface-2" />
        ))}
      </div>
    </div>
  );
}

/** Label, track and value columns, shared by the dumbbells and the axis so the ticks line up with the dots. */
const COLUMNS = 'sm:grid-cols-[9.5rem_minmax(0,1fr)_9rem]';

/** The dumbbells on one shared axis, the two text blocks and the table, all drawn from the same answer. */
export function PeriodComparisonView({ cmp }: { cmp: PeriodComparisonData }) {
  const t = useT();
  const captionId = useId();
  const interpretationId = useId();
  const s = t.statistics;
  const c = s.comparison;
  const find = (category: StatsCategoryId, metric: ComparisonMetric) => cmp.rows.find((r) => r.category === category && r.metric === metric);
  const measured = cmp.rows.filter((r) => r.metric === 'p95Ms').flatMap((r) => [r.a, r.b]).filter((v): v is number => v !== null);
  if (measured.length === 0) return <EmptyState title={c.empty} />;

  const axis = axisScale(Math.max(...measured));
  const { text, recommendation } = interpretS2(cmp);

  const missing = (why: string) => (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{why}</span>
    </>
  );
  const value = (category: StatsCategoryId, metric: ComparisonMetric, v: number | null): ReactNode => {
    if (v === null) return missing(c.notMeasured);
    if (metric === 'p95Ms') return formatLatency(v);
    if (metric === 'opsPerS') return formatRate(v);
    if (metric === 'errorRate') return formatPercent(v, 1);
    // Volume: readings for meters, bytes for files (docs/api.md).
    return category === 'meter_readings' ? plural(v, c.readings) : formatBytes(v);
  };
  const columns: ChartColumn[] = [
    { key: 'category', label: c.columns.category },
    { key: 'metric', label: c.columns.metric },
    { key: 'a', label: c.column(s.periods.a, cmp.periodA.label), align: 'right' },
    { key: 'b', label: c.column(s.periods.b, cmp.periodB.label), align: 'right' },
    { key: 'delta', label: c.columns.delta, align: 'right' },
  ];
  const rows = STATS_CATEGORIES.flatMap((category) =>
    COMPARISON_METRICS.map((metric) => {
      const r = find(category, metric);
      return {
        category: s.category[category].label,
        metric: c.metric[metric],
        a: value(category, metric, r?.a ?? null),
        b: value(category, metric, r?.b ?? null),
        delta: r?.deltaPct === null || r?.deltaPct === undefined ? missing(c.noDelta) : formatDelta(r.deltaPct),
      };
    }),
  );

  return (
    <>
      <figure aria-labelledby={captionId} aria-describedby={interpretationId} className="m-0 flex flex-col gap-3">
        <figcaption id={captionId} className="text-sm text-ink-2">
          {c.caption(tickLabel(axis.max, axis.max))}
        </figcaption>
        <ul aria-label={c.legend} className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] font-semibold text-ink-2">
          <li className="flex items-center gap-2">
            <span data-dot="a" aria-hidden="true" className="size-3.5 shrink-0 rounded-full border-[3px] border-ink-2" />
            {c.period(s.periods.a, cmp.periodA.label)}
          </li>
          <li className="flex items-center gap-2">
            <span data-dot="b" aria-hidden="true" className="size-3.5 shrink-0 rounded-full bg-ink-2" />
            {c.period(s.periods.b, cmp.periodB.label)}
          </li>
        </ul>
        <div>
          <ul className="flex flex-col">
            {STATS_CATEGORIES.map((category) => (
              <Dumbbell key={category} category={category} p95={find(category, 'p95Ms')} axis={axis} />
            ))}
          </ul>
          <div aria-hidden="true" className={cn('grid gap-x-3', COLUMNS)}>
            <div className="relative mx-2 h-5 sm:col-start-2">
              {axis.ticks.map((tick) => (
                <span
                  key={tick}
                  data-tick
                  className="absolute top-0.5 -translate-x-1/2 text-xs whitespace-nowrap text-ink-3"
                  style={{ left: `${at(tick, axis.max)}%` }}
                >
                  {tickLabel(tick, axis.max)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </figure>
      <Insight
        interpretationId={interpretationId}
        interpretation={[{ key: 's2', text }]}
        recommendation={[{ key: 's2', text: recommendation }]}
      />
      <TableDetails title={c.title} columns={columns} rows={rows} />
    </>
  );
}

type Axis = { max: number; ticks: number[] };

/**
 * One category: a hollow dot for period A, a dot filled with the category colour for period B, joined by a line, on
 * the shared axis. The drawing is hidden from screen readers, which read the two values in words instead.
 */
function Dumbbell({ category, p95, axis }: { category: StatsCategoryId; p95: ComparisonRow | undefined; axis: Axis }) {
  const t = useT();
  const c = t.statistics.comparison;
  const a = p95?.a ?? null;
  const b = p95?.b ?? null;
  const delta = p95?.deltaPct === null || p95?.deltaPct === undefined ? null : formatDelta(p95.deltaPct);
  const from = a === null ? null : at(a, axis.max);
  const to = b === null ? null : at(b, axis.max);
  const fill = CATEGORY_FILL[category];

  return (
    <li data-dumbbell className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border py-2.5', COLUMNS)}>
      <span data-label className="flex min-w-0 items-center gap-2 text-sm font-semibold sm:col-start-1 sm:row-start-1">
        <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', fill)} />
        {t.statistics.category[category].label}
      </span>
      <span className="sr-only">
        {c.row({ a: a === null ? c.notMeasured : formatLatency(a), b: b === null ? c.notMeasured : formatLatency(b), delta })}
      </span>
      <span aria-hidden="true" className="text-sm whitespace-nowrap sm:col-start-3 sm:row-start-1">
        <span data-value className="font-bold">
          {a === null && b === null ? c.notMeasured : pair(a, b)}
        </span>
        {delta && (
          <>
            {' '}
            <span data-delta className="text-[13px] text-ink-2">
              {delta}
            </span>
          </>
        )}
      </span>
      <span data-track aria-hidden="true" className="relative col-span-2 h-6 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <span className="absolute inset-x-2 inset-y-0">
          {axis.ticks.map((tick) => (
            <span key={tick} className="absolute inset-y-0 w-px bg-border" style={{ left: `${at(tick, axis.max)}%` }} />
          ))}
          {from !== null && to !== null && (
            // From the edge of one dot to the edge of the other (dots are 16 px wide); nothing when they overlap.
            <span
              className="absolute top-[11px] h-0.5 bg-ink-3"
              style={{ left: `calc(${Math.min(from, to)}% + 8px)`, width: `calc(${Math.abs(to - from)}% - 16px)` }}
            />
          )}
          {to !== null && <span data-dot="b" className={cn('absolute top-1 -ml-2 size-4 rounded-full', fill)} style={{ left: `${to}%` }} />}
          {/* A is drawn last, as a ring, so it stays visible when both periods measured the same. */}
          {from !== null && (
            <span data-dot="a" className="absolute top-1 -ml-2 size-4 rounded-full border-[3px] border-ink-2" style={{ left: `${from}%` }} />
          )}
        </span>
      </span>
    </li>
  );
}
