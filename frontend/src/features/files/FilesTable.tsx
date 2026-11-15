'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, LifeBuoy, Lock } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { SafeName } from '@/components/SafeName';
import { Tag } from '@/components/ui/tag';
import { DownloadButton } from '@/features/integrity/DownloadButton';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatBytes, formatDateTime, formatInt } from '@/lib/i18n/format';
import type { StorageId } from '@/lib/upload/types';
import { useAppStore } from '@/stores/app-store';
import type { FileCategoryId, FileSort } from './filters';
import { IntegrityBadge } from './IntegrityBadge';
import { OriginTag } from './OriginTag';
import type { FileItem } from './queries';
import { SeverityLevel } from './SeverityLevel';

export const CATEGORY_DOT: Record<FileCategoryId, string> = {
  fault_records: 'bg-cat-fault',
  drone_videos: 'bg-cat-drone',
  connection_documents: 'bg-cat-connection',
  meter_readings: 'bg-cat-meter',
};

// ─── new fault rows (6c.3) ─────────────────────────────────────────────────────────────────────────────────

/** How long a fault counts as new: "Nou · acum N s" and the info tint, then the wash back to the surface. */
const NEW_ROW_S = 60;

const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** One shared 1 s clock for every row that is still new; it stops when the last one unsubscribes. */
function onEverySecond(listener: () => void): () => void {
  tickListeners.add(listener);
  tickTimer ??= setInterval(() => tickListeners.forEach((l) => l()), 1_000);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

/** Whole seconds, so the snapshot stays equal between reads within a second. */
const nowSeconds = () => Math.floor(Date.now() / 1_000);
/** Before hydration nothing is new. */
const serverSeconds = () => 0;
const noTicks = () => () => {};

/** Ticks until `untilS`, then unsubscribes itself: a row that stopped being new never re-renders on the clock. */
function ticksUntil(untilS: number) {
  return (onTick: () => void) => {
    if (nowSeconds() >= untilS) return noTicks();
    const stop = onEverySecond(() => {
      onTick();
      if (nowSeconds() >= untilS) stop();
    });
    return stop;
  };
}

/**
 * Seconds since a fault was created while that is under a minute, else null (always null for a null `createdAt`).
 * The age comes from `createdAt`, not from when the row reached this table, so a fault uploaded just before a role
 * switch or a reload still reads "Nou · acum 12 s". While "Actualizări live" is paused (A11Y-14) it stays still.
 */
function useNewRowAge(createdAt: string | null, paused: boolean): number | null {
  const createdS = createdAt === null ? Number.NaN : Math.floor(Date.parse(createdAt) / 1_000);
  const untilS = createdS + NEW_ROW_S;
  const subscribe = useMemo(() => (paused || !Number.isFinite(untilS) ? noTicks : ticksUntil(untilS)), [paused, untilS]);
  const ageS = useSyncExternalStore(subscribe, nowSeconds, serverSeconds) - createdS;
  // A time stamp a minute or more ahead of this clock means a wrong clock: never "new" then.
  return ageS > -NEW_ROW_S && ageS < NEW_ROW_S ? Math.max(0, ageS) : null;
}

function NewMarker({ ageS }: { ageS: number }) {
  const t = useT();
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-chip bg-surface px-2 text-[13px] font-semibold text-info-ink tabular-nums shadow-[inset_0_0_0_1.5px_var(--fg-info)]">
      {t.files.newRow(formatInt(ageS))}
    </span>
  );
}

/** Storage label only, never a location (N7); a fallback write says so in words (FE-08). */
export function StorageTag({ storage, usedFallback }: { storage: StorageId; usedFallback: boolean }) {
  const t = useT();
  const label = t.files.storage[storage] ?? String(storage).toUpperCase();
  if (!usedFallback) return <Tag>{label}</Tag>;
  return (
    <Tag title={t.files.fallbackHint} className="bg-warn-tint text-warn-ink">
      <LifeBuoy aria-hidden="true" className="size-3.5" />
      {t.files.fallback(label)}
    </Tag>
  );
}

export function EncryptedTag() {
  const t = useT();
  return (
    <span className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-chip px-2 text-[13px] font-semibold text-ok-ink shadow-[inset_0_0_0_1.5px_var(--fg-ok)]">
      <Lock aria-hidden="true" className="size-3.5" />
      {t.files.encrypted}
    </span>
  );
}

function Th({ children, className, ...rest }: { children: ReactNode; className?: string; 'aria-sort'?: 'ascending' | 'descending' }) {
  return (
    <th scope="col" className={cn('px-3 py-2.5 font-semibold whitespace-nowrap', className)} {...rest}>
      {children}
    </th>
  );
}

function SortHeader({ column, label, sort, onSort, className }: { column: 'size' | 'createdAt'; label: string; sort: FileSort; onSort(next: FileSort): void; className?: string }) {
  const active = sort === column || sort === `-${column}`;
  const descending = sort.startsWith('-');
  // A new column starts with the largest / newest first; the active one flips.
  const next = (active && descending ? column : `-${column}`) as FileSort;
  const Icon = !active ? ArrowUpDown : descending ? ArrowDown : ArrowUp;
  return (
    <Th className={className} aria-sort={active ? (descending ? 'descending' : 'ascending') : undefined}>
      <button
        type="button"
        onClick={() => onSort(next)}
        className="-mx-1.5 inline-flex h-8 items-center gap-1 rounded-control px-1.5 font-semibold hover:bg-sunken"
      >
        {label}
        <Icon aria-hidden="true" className={cn('size-3.5', !active && 'text-ink-3')} />
      </button>
    </Th>
  );
}

type RowProps = { r: FileItem; showCategory: boolean; showSeverity: boolean; paused: boolean };

/**
 * One file. A fault created in the last minute is tinted and says "Nou · acum N s". Rows are keyed by id, so a row
 * inserted above never re-creates the others and keyboard focus stays where it was.
 */
function FileRow({ r, showCategory, showSeverity, paused }: RowProps) {
  const t = useT();
  // direction.md §9 "New fault row": only faults get the marker; meter batches arrive every few seconds.
  const ageS = useNewRowAge(r.category === 'fault_records' ? r.createdAt : null, paused);
  const isNew = ageS !== null;
  const substation = r.metadata?.substation;
  const cell = 'px-3 py-2';
  return (
    <tr
      data-new={isNew || undefined}
      // The wash: when the minute is up the tint fades to the surface over --fg-dur-fast (0 ms under reduced motion).
      className={cn('h-(--fg-row-h) border-t border-border align-middle transition-colors duration-(--fg-dur-fast) ease-(--fg-ease-smooth)', isNew && 'row-in bg-info-tint')}
    >
      <td className={cn(cell, 'max-w-[17rem]')}>
        <Link href={`/files/${encodeURIComponent(r.id)}`} className="inline-flex max-w-full font-semibold text-ink hover:underline">
          <SafeName name={r.displayName} />
        </Link>
        {(showCategory || substation || isNew) && (
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2">
            {showCategory && (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span aria-hidden="true" className={cn('size-2 rounded-full', CATEGORY_DOT[r.category])} />
                {t.files.categoryOne[r.category] ?? r.category}
              </span>
            )}
            {showCategory && substation && <span aria-hidden="true">·</span>}
            {substation && (
              <span dir="auto" className="truncate [unicode-bidi:isolate]">
                {substation}
              </span>
            )}
            {isNew && <NewMarker ageS={ageS} />}
          </span>
        )}
      </td>
      <td className={cn(cell, 'whitespace-nowrap')}>{r.zone ? (t.files.zones[r.zone] ?? r.zone) : <span className="text-ink-3">{t.files.noZone}</span>}</td>
      {showSeverity && (
        <td className={cell}>
          <SeverityLevel severity={r.metadata?.severity} />
        </td>
      )}
      <td className={cn(cell, 'text-right whitespace-nowrap tabular-nums')}>{formatBytes(r.size)}</td>
      <td className={cn(cell, 'whitespace-nowrap')}>
        <time dateTime={r.createdAt} className="tabular-nums">
          {formatDateTime(r.createdAt)}
        </time>
        {r.uploadedBy && <span className="block text-[13px] text-ink-2">{t.files.uploadedBy(r.uploadedBy.displayName)}</span>}
      </td>
      <td className={cell}>
        <span className="flex flex-wrap items-center gap-1.5">
          <StorageTag storage={r.storage} usedFallback={r.usedFallback} />
          {r.encryptedAtRest && <EncryptedTag />}
        </span>
      </td>
      <td className={cell}>
        <IntegrityBadge state={r.integrity} />
      </td>
      <td className={cell}>
        <OriginTag origin={r.origin} />
      </td>
      <td className={cell}>
        <DownloadButton fileId={r.id} fileName={r.displayName} size={r.size} storage={r.storage} />
      </td>
    </tr>
  );
}

/**
 * The files list (FE-03): a real table, sortable headers are buttons with `aria-sort`, names through SafeName
 * (SR-7), storage as a label, integrity as icon + word. In "Toate" the category sits under the name, so the
 * integrity column stays on screen at 1440 px. Severity shows in the fault list once the rows carry it. New faults
 * arrive by refetch (the live bridge invalidates the list on `file.created`) and are marked in place (6c.3).
 */
export function FilesTable({ rows, category, sort, onSort }: { rows: FileItem[]; category?: FileCategoryId; sort: FileSort; onSort(next: FileSort): void }) {
  const t = useT();
  const paused = useAppStore((s) => s.livePaused);
  const c = t.files.columns;
  const showCategory = !category;
  // GET /files does not send fault metadata yet (backend ask): no column of dashes until it does.
  const showSeverity = category === 'fault_records' && rows.some((r) => r.metadata?.severity);
  const what = category ? t.files.categories[category] : t.files.title;
  return (
    // A focusable scroll region keeps the page free of 2-D scrolling at 320 px (A11Y-23).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label={t.files.tableRegion} tabIndex={0} className="table-scroll rounded-card glass-dense">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t.files.caption(what, t.files.sortLabel[sort])}</caption>
        <thead className="bg-surface-2 text-[13px] text-ink-2">
          <tr>
            <Th>{c.name}</Th>
            <Th>{c.zone}</Th>
            {showSeverity && <Th>{c.severity}</Th>}
            <SortHeader column="size" label={c.size} sort={sort} onSort={onSort} className="text-right" />
            <SortHeader column="createdAt" label={c.uploaded} sort={sort} onSort={onSort} />
            <Th>{c.storage}</Th>
            <Th>{c.integrity}</Th>
            <Th>{c.origin}</Th>
            <Th>{c.download}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <FileRow key={r.id} r={r} showCategory={showCategory} showSeverity={showSeverity} paused={paused} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
