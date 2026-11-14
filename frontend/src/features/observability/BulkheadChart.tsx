'use client';

import dynamic from 'next/dynamic';
import { useId, useState } from 'react';
import { ChartFigure } from '@/components/charts/ChartFigure';
import { ErrorState } from '@/components/ErrorState';
import { useGuarantees } from '@/features/guarantees/queries';
import { decimal, metricOf, seconds } from '@/features/guarantees/sentences';
import { useT } from '@/lib/i18n';
import { CATEGORY_IDS, type CategoryId, type SeriesWindow } from '@/lib/monitoring/contract';
import { BULKHEAD_SERIES, lastValues, toRows } from './bulkhead-series';
import { SERIES_WINDOWS, useBulkhead } from './queries';
import { WindowSelect } from './WindowSelect';

const BulkheadLines = dynamic(() => import('./BulkheadLines'), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="h-[280px] rounded-panel bg-surface-2" />,
});

/** The fault guarantee's target when the board does not say otherwise (BA-30: upload → dispatcher p95 ≤ 2 s). */
const DEFAULT_FAULT_TARGET_MS = 2000;

/** A short line in the series' colour and dash, so the legend matches the chart without relying on colour. */
function Swatch({ category }: { category: CategoryId }) {
  const s = BULKHEAD_SERIES[category];
  return (
    <svg width="28" height="10" aria-hidden="true" className="shrink-0">
      <line x1="0" y1="5" x2="28" y2="5" stroke={`var(${s.colorVar})`} strokeWidth="2.5" strokeDasharray={s.dash} />
    </svg>
  );
}

/**
 * Bulkhead chart (FE-10, BA-44): p95 of the four categories on one y-axis with the fault target as a threshold line,
 * direct end labels ("Avarii 3,4 s"), the table alternative with every point, and this replica's compartments.
 */
export function BulkheadChart({ initialWindow = '15m', headingLevel = 2 }: { initialWindow?: SeriesWindow; headingLevel?: 2 | 3 }) {
  const { monitoring: t, common } = useT();
  const b = t.bulkhead;
  const titleId = useId();
  const [window, setWindow] = useState<SeriesWindow>(initialWindow);
  const bulkhead = useBulkhead(window);
  const guarantees = useGuarantees();

  const fault = guarantees.data?.find((g) => g.category === 'fault_records');
  const targetMs = (fault ? metricOf(fault, 'uploadToAvailableP95Ms').threshold : null) ?? DEFAULT_FAULT_TARGET_MS;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  let body;
  if (bulkhead.data) {
    const { series, compartments } = bulkhead.data;
    const rows = toRows(series);
    const last = lastValues(series);
    const fmt = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : seconds(ms));
    const worst = CATEGORY_IDS.filter((c) => last[c] !== null).sort((x, y) => (last[y] ?? 0) - (last[x] ?? 0))[0];
    const columns = [{ key: 'time', label: b.time }, ...CATEGORY_IDS.map((c) => ({ key: c, label: t.categories[c], align: 'right' as const }))];
    const tableRows = rows.map((r) => ({
      time: r.time,
      ...Object.fromEntries(CATEGORY_IDS.map((c) => [c, fmt(r[c] === null || r[c] === undefined ? null : (r[c] as number) * 1000)])),
    }));
    body = (
      <>
        <ChartFigure
          title={b.chartTitle(t.observability.windowsLong[window])}
          interpretation={worst ? b.interpretation(`${t.categories[worst]} (${seconds(last[worst]!)})`) : b.interpretationNone}
          columns={columns}
          rows={tableRows}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <BulkheadLines
                rows={rows}
                names={t.categories}
                targetS={targetMs / 1000}
                targetLabel={b.target(seconds(targetMs))}
                yLabel={b.yAxis}
              />
            </div>
            <ul className="flex flex-row flex-wrap gap-x-4 gap-y-1 lg:w-48 lg:flex-col">
              {CATEGORY_IDS.map((c) => (
                <li key={c} data-series={c} className="flex items-center gap-2 text-sm font-semibold tabular-nums">
                  <Swatch category={c} />
                  <span>{b.endLabel(t.categories[c], last[c] === null ? b.noData : seconds(last[c]!))}</span>
                </li>
              ))}
            </ul>
          </div>
        </ChartFigure>
        {compartments.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-ink-2">{b.compartments}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {compartments.map((c) => (
                <div key={c.category} className="rounded-panel border border-border px-3 py-2">
                  <dt className="text-ink-2">{t.categories[c.category]}</dt>
                  <dd className="font-semibold tabular-nums">{b.compartment(decimal(c.active), decimal(c.queued))}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </>
    );
  } else if (bulkhead.isError) {
    body = <ErrorState error={bulkhead.error} onRetry={() => void bulkhead.refetch()} />;
  } else {
    body = (
      <div aria-hidden="true" className="h-[280px] animate-pulse rounded-panel bg-surface-2 motion-reduce:animate-none" />
    );
  }

  return (
    <section aria-labelledby={titleId} aria-busy={bulkhead.isPending || bulkhead.isPlaceholderData} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <Heading id={titleId} className="text-[22px] font-bold">
            {b.title}
          </Heading>
          <p className="text-ink-2">{b.lead}</p>
        </div>
        <WindowSelect value={window} windows={SERIES_WINDOWS} onChange={setWindow} label={b.windowLabel} />
      </div>
      {bulkhead.isPending && <span className="sr-only">{common.loading}</span>}
      {body}
    </section>
  );
}
