'use client';

import { Check } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { ChartColumn } from '@/components/charts/ChartTable';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';
import { plural, useT } from '@/lib/i18n';
import { formatBytes, formatInt, formatPercent } from '@/lib/i18n/format';
import { STORAGE_IDS, type StatsCategoryId, type StorageFit as StorageFitData, type StorageFitItem, type StorageId, type StoragePerformance } from './contract';
import { Insight } from './Insight';
import { formatLatency, interpretS1 } from './interpret';
import { useStorageFit } from './queries';
import { TableDetails } from './TableDetails';

/** Bars take their category's colour; the storages are told apart by the axis label only, never by colour (FE-10). */
export const CATEGORY_FILL: Readonly<Record<StatsCategoryId, string>> = {
  meter_readings: 'bg-cat-meter',
  fault_records: 'bg-cat-fault',
  connection_documents: 'bg-cat-connection',
  drone_videos: 'bg-cat-drone',
};

/** The measurement of one storage, or an empty one when that storage never served the category. */
function measurement(item: StorageFitItem, storage: StorageId): StoragePerformance {
  return item.storages.find((s) => s.storage === storage) ?? { storage, samples: 0, p50Ms: null, p95Ms: null, throughputBps: null, errorRate: null };
}

/** Bar length in % of the slowest storage of the facet (each category on its own scale), never thinner than 2 %. */
function barWidth(p95Ms: number, max: number): number {
  return max > 0 ? Math.max(2, Math.round((p95Ms / max) * 1000) / 10) : 0;
}

/** S1 · "Ce storage se potrivește fiecărei categorii?" (FE-10, beat 8), with its loading, error and empty states. */
export function StorageFit() {
  const t = useT();
  const titleId = useId();
  const fit = useStorageFit();
  let body: ReactNode;
  if (fit.isPending) body = <Loading />;
  else if (fit.isError) body = <ErrorState error={fit.error} onRetry={() => void fit.refetch()} />;
  else if (fit.data.items.length === 0) body = <EmptyState title={t.statistics.fit.empty} />;
  else body = <StorageFitView fit={fit.data} />;

  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold tracking-(--fg-tracking-caps) text-ink-2 uppercase">{t.statistics.fit.eyebrow}</span>
        <h2 id={titleId} className="text-[22px] font-bold">
          {t.statistics.fit.title}
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
      <div aria-hidden="true" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {SKELETON.map((i) => (
          <div key={i} className="h-36 skeleton rounded-panel bg-surface-2" />
        ))}
      </div>
    </div>
  );
}

/** The small multiples, the two text blocks and the table, all drawn from the same answer. */
export function StorageFitView({ fit }: { fit: StorageFitData }) {
  const t = useT();
  const captionId = useId();
  const interpretationId = useId();
  const s = t.statistics;

  const lines = fit.items.map((item) => ({ key: item.category, label: s.category[item.category].label, ...interpretS1(item) }));
  const operations = fit.items.reduce((sum, item) => sum + item.storages.reduce((n, m) => n + m.samples, 0), 0);
  const missing = (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{s.fit.notMeasured}</span>
    </>
  );
  const columns: ChartColumn[] = [
    { key: 'category', label: s.fit.column.category },
    { key: 'storage', label: s.fit.column.storage },
    { key: 'samples', label: s.fit.column.samples, align: 'right' },
    { key: 'p50', label: s.fit.column.p50, align: 'right' },
    { key: 'p95', label: s.fit.column.p95, align: 'right' },
    { key: 'throughput', label: s.fit.column.throughput, align: 'right' },
    { key: 'errorRate', label: s.fit.column.errorRate, align: 'right' },
    { key: 'recommended', label: s.fit.column.recommended },
  ];
  const rows = fit.items.flatMap((item) =>
    STORAGE_IDS.map((storage) => {
      const m = measurement(item, storage);
      return {
        category: s.category[item.category].label,
        storage: s.storage[storage],
        samples: formatInt(m.samples),
        p50: m.p50Ms === null ? missing : formatLatency(m.p50Ms),
        p95: m.p95Ms === null ? missing : formatLatency(m.p95Ms),
        throughput: m.throughputBps === null ? missing : `${formatBytes(m.throughputBps)}/s`,
        errorRate: m.errorRate === null ? missing : formatPercent(m.errorRate, 1),
        recommended: storage === item.recommendedStorage ? s.fit.yes : s.fit.no,
      };
    }),
  );

  return (
    <>
      <figure aria-labelledby={captionId} aria-describedby={interpretationId} className="m-0 flex flex-col gap-4">
        <figcaption id={captionId} className="text-sm text-ink-2">
          {s.fit.caption}
        </figcaption>
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
          {fit.items.map((item) => (
            <Facet key={item.category} item={item} />
          ))}
        </div>
        <p className="text-[13px] text-ink-2">{s.fit.note(plural(operations, s.s1.operations))}</p>
      </figure>
      <Insight
        interpretationId={interpretationId}
        interpretation={lines.map(({ key, label, text }) => ({ key, label, text }))}
        recommendation={lines.map(({ key, label, recommendation }) => ({ key, label, text: recommendation }))}
      />
      <TableDetails title={s.fit.title} columns={columns} rows={rows} />
    </>
  );
}

/** One category: a horizontal bar per storage (p95 at write), the storages on the axis in a fixed order, and its tag. */
function Facet({ item }: { item: StorageFitItem }) {
  const t = useT();
  const headingId = useId();
  const category = t.statistics.category[item.category];
  const measured = STORAGE_IDS.map((storage) => measurement(item, storage));
  const max = Math.max(0, ...measured.map((m) => m.p95Ms ?? 0));

  return (
    <div role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={headingId} className="flex items-center gap-2 text-[15px] font-bold">
          <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', CATEGORY_FILL[item.category])} />
          {category.label}
        </h3>
        <span className="text-[13px] text-ink-2">{category.size}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {measured.map((m) => (
          <li key={m.storage} className="grid grid-cols-[2.75rem_minmax(0,1fr)_4.75rem] items-center gap-2.5 text-sm">
            <span data-axis className="font-semibold text-ink-2">
              {t.statistics.storage[m.storage]}
            </span>
            <span aria-hidden="true" className="h-[18px] overflow-hidden rounded-r-chip bg-sunken">
              {m.p95Ms !== null && (
                <span data-bar className={cn('block h-full rounded-r-chip', CATEGORY_FILL[item.category])} style={{ width: `${barWidth(m.p95Ms, max)}%` }} />
              )}
            </span>
            <span data-value className={cn('text-right', m.p95Ms === null ? 'text-ink-2' : 'font-semibold')}>
              {m.p95Ms === null ? t.statistics.fit.notMeasured : formatLatency(m.p95Ms)}
            </span>
          </li>
        ))}
      </ul>
      <Tag className="w-fit bg-ok-tint font-bold text-ok-ink">
        <Check aria-hidden="true" className="size-4" />
        {t.statistics.fit.recommended(t.statistics.storage[item.recommendedStorage])}
      </Tag>
    </div>
  );
}
