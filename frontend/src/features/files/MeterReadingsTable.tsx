'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { SafeName } from '@/components/SafeName';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import { StorageTag } from './FilesTable';
import { OriginTag } from './OriginTag';
import type { MeterReading } from './queries';

const NBSP = ' ';
/** The simulator rounds a 15-minute consumption to Wh, so three decimals keep every reading exact and aligned. */
const kwhFormat = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
/** "1 234,500" (NBSP thousands, comma decimals), as `formatBytes` and the other Romanian number formats. */
const formatKwh = (kwh: number) => kwhFormat.format(kwh).replace(/\./g, NBSP);

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn('px-3 py-2.5 font-semibold whitespace-nowrap', className)}>
      {children}
    </th>
  );
}

/**
 * kWh against the largest reading on the page: a zero or a spike (the anomalies S3 looks for) stands out while
 * scanning. Decorative: the number next to it carries the value.
 */
function KwhBar({ kwh, max }: { kwh: number; max: number }) {
  const pct = max > 0 && kwh > 0 ? Math.max(4, Math.round((kwh / max) * 100)) : 0;
  return (
    <span aria-hidden="true" className="block h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-sunken">
      <span className="block h-full rounded-full bg-cat-meter" style={{ width: `${pct}%` }} />
    </span>
  );
}

/**
 * The meter readings view of the files list (SC-04 "readings table variant", FE-11): one row per reading with its
 * meter, zone, reading time, kWh and sequence. The meter id links to the file the reading was stored in (its
 * batch), which opens the normal file detail: hash, storage, policy, chain of custody and download.
 */
export function MeterReadingsTable({ rows }: { rows: MeterReading[] }) {
  const t = useT();
  const c = t.files.columns;
  const m = t.files.meter.columns;
  const max = rows.reduce((top, r) => Math.max(top, r.kwh), 0);
  const cell = 'px-3 py-2';
  return (
    // A focusable scroll region keeps the page free of 2-D scrolling at 320 px (A11Y-23).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label={t.files.meter.tableRegion} tabIndex={0} className="overflow-x-auto rounded-card border border-border bg-surface shadow-e1">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t.files.meter.caption}</caption>
        <thead className="bg-surface-2 text-[13px] text-ink-2">
          <tr>
            <Th>{m.meter}</Th>
            <Th>{c.zone}</Th>
            <Th>{m.readingTime}</Th>
            <Th className="text-right">{m.kwh}</Th>
            <Th className="text-right">{m.sequence}</Th>
            <Th>{c.storage}</Th>
            <Th>{c.origin}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.fileId}:${r.meterId}:${r.sequence}`} className="h-(--fg-row-h) border-t border-border align-middle">
              <td className={cn(cell, 'max-w-[14rem]')}>
                <Link href={`/files/${encodeURIComponent(r.fileId)}`} className="inline-flex max-w-full font-semibold text-ink tabular-nums hover:underline">
                  <SafeName name={r.meterId} />
                </Link>
              </td>
              <td className={cn(cell, 'whitespace-nowrap')}>{t.files.zones[r.zone] ?? r.zone}</td>
              <td className={cn(cell, 'whitespace-nowrap')}>
                <time dateTime={r.readingTime} className="tabular-nums">
                  {formatDateTime(r.readingTime)}
                </time>
              </td>
              <td className={cell}>
                <span className="flex items-center justify-end gap-2.5">
                  <KwhBar kwh={r.kwh} max={max} />
                  <span className="whitespace-nowrap tabular-nums">{formatKwh(r.kwh)}</span>
                </span>
              </td>
              {/* A counter the meter sends, part of the reading id (meter:sequence): shown as sent, not grouped. */}
              <td className={cn(cell, 'text-right whitespace-nowrap tabular-nums')}>{String(r.sequence)}</td>
              <td className={cell}>
                <StorageTag storage={r.storage} usedFallback={false} />
              </td>
              <td className={cell}>
                <OriginTag origin={r.origin} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
