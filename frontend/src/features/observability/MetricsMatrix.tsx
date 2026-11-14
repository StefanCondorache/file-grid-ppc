'use client';

import { useId } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { StatusChip } from '@/components/ui/status-chip';
import { decimal, percent } from '@/features/guarantees/sentences';
import { STRIP_ORDER } from '@/features/health/queries';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatBytes, formatDuration } from '@/lib/i18n/format';
import { CATEGORY_IDS, type CategoryId, type MatrixWindow, type MetricsCell } from '@/lib/monitoring/contract';
import { useAppStore } from '@/stores/app-store';
import { MATRIX_POLL_MS, useMetricsMatrix } from './queries';

const NBSP = ' ';

/** A cell is "Peste prag" when more than this share of its operations failed (accessibility.md §5, FE-09). */
export const ERROR_RATE_LIMIT = 0.01;

const CATEGORY_DOT: Record<CategoryId, string> = {
  meter_readings: 'bg-cat-meter',
  fault_records: 'bg-cat-fault',
  connection_documents: 'bg-cat-connection',
  drone_videos: 'bg-cat-drone',
};

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** `p95 410 ms`, kept on one line; a dash when the window has no successful sample. */
function latency(label: string, ms: number | null, missing: string): string {
  return `${label}${NBSP}${ms === null ? missing : formatDuration(ms)}`;
}

/** At most one decimal; a value that would round to zero but is not zero reads `< 0,1`, never a misleading `0`. */
function small(n: number): string {
  return n > 0 && n < 0.05 ? `<${NBSP}${decimal(0.1)}` : decimal(n);
}

/** `0,2 %`, `100 %`, `< 0,1 %`. */
function errorPercent(rate: number): string {
  return `${small(rate * 100)}${NBSP}%`;
}

const th = 'border-b border-border bg-surface-2 px-4 py-2.5 text-left text-[13px] font-semibold text-ink-2';
const td = 'border-b border-l border-border px-4 py-3 align-top';

function Cell({ cell }: { cell: MetricsCell | undefined }) {
  const t = useT().monitoring.observability;
  if (!cell || cell.noTraffic) {
    return (
      <td data-traffic="none" className={cn(td, 'bg-surface-2 text-[13px] text-ink-3')}>
        {t.noTraffic}
      </td>
    );
  }
  const over = cell.errorRate !== null && cell.errorRate > ERROR_RATE_LIMIT;
  const rate = [cell.throughputBps === null ? null : t.perSecond(formatBytes(cell.throughputBps)), cell.opsPerS === null ? null : t.ops(small(cell.opsPerS))]
    .filter((x): x is string => x !== null)
    .join(' · ');
  return (
    <td data-traffic="some" data-over={over} className={cn(td, over ? 'bg-warn-tint' : 'bg-surface')}>
      <div className="flex flex-col items-start gap-1">
        <span className="text-[18px] leading-tight font-bold">{latency('p95', cell.p95Ms, t.missing)}</span>
        <span className="text-[13px] text-ink-2">
          {latency('p50', cell.p50Ms, t.missing)} · {latency('p99', cell.p99Ms, t.missing)}
        </span>
        <span className="text-[13px] text-ink-2">{rate || t.missing}</span>
        <span className={cn('text-[13px]', over ? 'font-bold text-warn-ink' : 'text-ink-2')}>
          {t.errors(cell.errorRate === null ? t.missing : errorPercent(cell.errorRate))}
        </span>
        {over && <StatusChip tone="warn" label={t.overThreshold} className="mt-1" />}
      </div>
    </td>
  );
}

/**
 * The category × storage matrix (SC-07, FE-09, N4): rows are the four categories, columns the three storages, and
 * every cell holds the p50 / p95 / p99 latency, throughput and error rate the server measured over the window, or
 * says "fără trafic". A real `<table>` (A11Y-20) in a focusable scroll region. It polls every 5 s while live updates
 * run and the tab is visible, and keeps the previous numbers on screen while a new window loads (no flash).
 */
export function MetricsMatrix({ window: span }: { window: MatrixWindow }) {
  const catalog = useT();
  const names = catalog.monitoring;
  const t = names.observability;
  const matrix = useMetricsMatrix(span);
  const paused = useAppStore((s) => s.livePaused);
  const captionId = useId();

  if (!matrix.data) {
    if (matrix.isError) return <ErrorState error={matrix.error} onRetry={() => void matrix.refetch()} />;
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">{catalog.common.loading}</span>
        <div aria-hidden="true" className="h-[22rem] skeleton rounded-card border border-border bg-surface-2" />
      </div>
    );
  }

  const data = matrix.data;
  const shown = data.window ?? span;
  const byKey = new Map(data.cells.map((c) => [`${c.category}:${c.storage}`, c]));
  const switching = matrix.isPlaceholderData;
  let status: string;
  if (switching) status = t.switching(t.windowsLong[span]);
  else if (paused) status = t.paused;
  else status = t.polling(`${MATRIX_POLL_MS / 1000}${NBSP}s`);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="region"
        aria-labelledby={captionId}
        aria-busy={switching}
        // A scroll container must be reachable by keyboard when the table is wider than the screen (WCAG 2.1.1, axe
        // scrollable-region-focusable): accessibility.md §5 asks for the matrix "wrapped in a focusable scroll region".
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto rounded-card border border-border bg-surface"
      >
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <caption id={captionId} className="sr-only">
            {t.caption(t.windowsLong[shown])}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cn(th, 'w-44')}>
                {t.corner}
              </th>
              {STRIP_ORDER.map((storage) => (
                <th key={storage} scope="col" className={cn(th, 'border-l')}>
                  {names.health.storages[storage]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORY_IDS.map((category) => (
              <tr key={category} data-category={category}>
                <th scope="row" className="border-b border-border px-4 py-3 text-left align-top font-semibold">
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-[3px]', CATEGORY_DOT[category])} />
                    {names.categories[category]}
                  </span>
                </th>
                {STRIP_ORDER.map((storage) => (
                  <Cell key={storage} cell={byKey.get(`${category}:${storage}`)} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap gap-x-2 text-[13px] text-ink-2">
        {data.generatedAt && <span>{t.updatedAt(clock.format(new Date(data.generatedAt)))}</span>}
        {data.generatedAt && <span aria-hidden="true">·</span>}
        <span>{status}</span>
        {matrix.isError && <span className="font-semibold text-crit-ink">{t.refreshFailed}</span>}
      </p>
      <p className="text-[13px] text-ink-2">{t.thresholdNote(percent(ERROR_RATE_LIMIT * 100))}</p>
    </div>
  );
}
