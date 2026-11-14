'use client';

import { useId, type ReactNode } from 'react';
import type { ChartColumn } from '@/components/charts/ChartTable';
import { RegionMap } from '@/components/charts/RegionMap';
import { ErrorState } from '@/components/ErrorState';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { plural, useT } from '@/lib/i18n';
import { formatInt, formatPercent } from '@/lib/i18n/format';
import type { GridInsights as GridInsightsData, MeterAnomaly } from './contract';
import { Insight } from './Insight';
import { interpretS3 } from './interpret';
import { useGridInsights } from './queries';
import { TableDetails } from './TableDetails';

const NBSP = ' ';
/** The anomaly table lists the newest readings only and says how many there are in all. */
export const NEWEST_ANOMALIES = 8;

const detectedFormat = new Intl.DateTimeFormat('ro-RO', {
  timeZone: 'Europe/Bucharest',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** "14 nov 19:45", Bucharest time, written like the period labels. */
function detected(iso: string): string {
  const parts = detectedFormat.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month').replace(/\.$/, '')} ${part('hour')}:${part('minute')}`;
}

const kwhFormat = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "3,86 kWh", "−0,42 kWh". */
const kwh = (n: number) => `${kwhFormat.format(n).replace(/^-/, '−').replace(/\./g, NBSP)}${NBSP}kWh`;

/**
 * The table fits a narrow card by growing taller, never by scrolling sideways: cells break between words (`break-word`
 * keeps whole words in the column widths), meter ids anywhere, and below `sm` the zone and time columns fold into the
 * meter and anomaly cells (`WIDE` / `FOLD`), so a phone gets two columns.
 */
const CELL = 'border-b border-border px-2 py-2 text-left align-top wrap-break-word sm:px-3';
const WIDE = 'hidden sm:table-cell';
const FOLD = 'block text-[13px] text-ink-2 sm:hidden';

/** S3 · "Ce spun datele despre rețea" (FE-10, beat 8) over the last 24 h, with its loading and error states. */
export function GridInsights() {
  const t = useT();
  const titleId = useId();
  const grid = useGridInsights();
  const g = t.statistics.grid;
  let body: ReactNode;
  if (grid.isPending) body = <Loading />;
  else if (grid.isError) body = <ErrorState error={grid.error} onRetry={() => void grid.refetch()} />;
  else body = <GridInsightsView insights={grid.data} />;

  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold tracking-(--fg-tracking-caps) text-ink-2 uppercase">{g.eyebrow}</span>
        <h2 id={titleId} className="text-[22px] font-bold">
          {g.title}
        </h2>
      </header>
      {body}
    </Card>
  );
}

function Loading() {
  const t = useT();
  return (
    <div role="status">
      <span className="sr-only">{t.common.loading}</span>
      <div aria-hidden="true" className="grid gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="aspect-[3/2] animate-pulse rounded-panel bg-surface-2 motion-reduce:animate-none" />
        <div className="h-48 animate-pulse rounded-panel bg-surface-2 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** The region map, the meter anomalies, the two text blocks and the map's table, all drawn from the same answer. */
export function GridInsightsView({ insights }: { insights: GridInsightsData }) {
  const t = useT();
  const captionId = useId();
  const interpretationId = useId();
  const s = t.statistics;
  const g = s.grid;

  const regions = insights.faultsByZone.map((z) => ({ zone: z.zone, name: s.zone[z.zone].label, count: z.count }));
  // Busiest first in the map's name; the sort is stable, so ties keep the regions' order.
  const busiest = [...regions].sort((x, y) => y.count - x.count);
  const total = regions.reduce((sum, r) => sum + r.count, 0);
  const { text, recommendation } = interpretS3(insights);

  const columns: ChartColumn[] = [
    { key: 'zone', label: g.table.zone },
    { key: 'faults', label: g.table.faults, align: 'right' },
    { key: 'share', label: g.table.share, align: 'right' },
  ];
  const rows = regions.map((r) => ({
    zone: r.name,
    faults: formatInt(r.count),
    share:
      total > 0 ? (
        formatPercent(r.count / total, 1)
      ) : (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">{s.comparison.noDelta}</span>
        </>
      ),
  }));

  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
        <figure aria-labelledby={captionId} aria-describedby={interpretationId} className="m-0 flex flex-col gap-3">
          <figcaption id={captionId} className="text-sm text-ink-2">
            {g.caption}
          </figcaption>
          <RegionMap
            regions={regions}
            title={g.map(busiest.map((r) => `${r.name} ${formatInt(r.count)}`))}
            legend={g.legend}
            className="mx-auto w-full max-w-[22rem]"
          />
          <p className="text-center text-[13px] text-ink-2">{g.note}</p>
        </figure>
        <Anomalies anomalies={insights.anomalies} />
      </div>
      <Insight
        interpretationId={interpretationId}
        interpretation={[{ key: 's3', text }]}
        recommendation={[{ key: 's3', text: recommendation }]}
      />
      <TableDetails title={g.title} columns={columns} rows={rows} />
    </>
  );
}

/** What a reading did, with its value when it says something ("Vârf brusc · 3,86 kWh"). */
function describe({ type, value }: MeterAnomaly, label: string): string {
  return value !== null && (type === 'spike' || type === 'negative') ? `${label} · ${kwh(value)}` : label;
}

/** The newest anomalous meter readings, in a table that wraps on narrow screens. */
function Anomalies({ anomalies }: { anomalies: readonly MeterAnomaly[] }) {
  const t = useT();
  const headingId = useId();
  const s = t.statistics;
  const g = s.grid;
  const shown = anomalies.slice(0, NEWEST_ANOMALIES);
  const headers = [
    { label: g.columns.meter, className: '' },
    { label: g.columns.zone, className: WIDE },
    { label: g.columns.type, className: '' },
    { label: g.columns.detectedAt, className: WIDE },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-base font-bold">
        {g.anomalies}
      </h3>
      {shown.length === 0 ? (
        <p className="text-ink-2">{g.noAnomalies}</p>
      ) : (
        <table aria-labelledby={headingId} className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header.label} scope="col" className={cn(CELL, 'bg-surface-2 font-semibold text-ink-2', header.className)}>
                  {header.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const zone = s.zone[a.zone].label;
              const when = detected(a.detectedAt);
              return (
                <tr key={`${a.meterId}|${a.detectedAt}|${a.type}`}>
                  <td className={cn(CELL, 'wrap-anywhere')}>
                    <span className="font-mono">{a.meterId}</span>
                    <span data-fold className={FOLD}>
                      {zone}
                    </span>
                  </td>
                  <td className={cn(CELL, WIDE)}>{zone}</td>
                  <td className={CELL}>
                    {describe(a, g.anomaly[a.type])}
                    <span data-fold className={FOLD}>
                      {when}
                    </span>
                  </td>
                  <td className={cn(CELL, WIDE)}>{when}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {anomalies.length > shown.length && (
        <p className="text-[13px] text-ink-2">{g.newest(shown.length, plural(anomalies.length, g.readings))}</p>
      )}
    </div>
  );
}
