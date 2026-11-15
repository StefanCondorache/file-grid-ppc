'use client';

import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/queries';
import type { Capability } from '@/lib/api/types';
import { can } from '@/lib/auth/capabilities';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import { FiltersBar } from './FiltersBar';
import { activeFilterCount, DEFAULT_FILTERS, FILE_CATEGORIES, parseFilters, toSearchParams, type FileCategoryId, type FileFilters } from './filters';
import { FilesTable } from './FilesTable';
import { MeterReadingsTable } from './MeterReadingsTable';
import { useFiles, useMeterReadings } from './queries';

const VIEW: Record<FileCategoryId, Capability> = {
  fault_records: 'view_fault', drone_videos: 'view_drone', connection_documents: 'view_connection', meter_readings: 'view_meters',
};

/** `total: null` when the server only estimates it: the page then says "Afișate 26–50" and moves on `hasMore`. */
function Pagination({ page, pageSize, total, shown, hasMore, onPage }: { page: number; pageSize: number; total: number | null; shown: number; hasMore: boolean; onPage(page: number): void }) {
  const t = useT();
  const start = (page - 1) * pageSize;
  const pages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const status =
    total === null
      ? t.files.showingOpen(formatInt(start + 1), formatInt(start + shown))
      : t.files.showing(formatInt(Math.min(total, start + 1)), formatInt(Math.min(total, page * pageSize)), formatInt(total));
  const last = pages === null ? !hasMore : page >= pages;
  return (
    <nav aria-label={t.files.pagination} className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-ink-2 tabular-nums">{status}</p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="px-2.5" aria-label={t.files.prev} title={t.files.prev} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-sm font-semibold tabular-nums">
          {pages === null ? t.files.pageOnly(formatInt(page)) : t.files.pageOf(formatInt(page), formatInt(pages))}
        </span>
        <Button variant="secondary" size="sm" className="px-2.5" aria-label={t.files.next} title={t.files.next} disabled={last} onClick={() => onPage(page + 1)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 rounded-card glass-dense p-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-10 rounded-control bg-sunken" />
      ))}
    </div>
  );
}

function FilteredEmpty({ title, body, onReset }: { title: string; body: string; onReset(): void }) {
  const t = useT();
  return (
    <EmptyState
      title={title}
      body={body}
      action={
        <Button variant="secondary" size="sm" onClick={onReset}>
          <RotateCcw aria-hidden="true" />
          {t.files.filters.reset}
        </Button>
      }
    />
  );
}

type BodyProps = { filters: FileFilters; go(next: FileFilters): void; reset(): void };

/** The generic files list (6c.2, live faults 6c.3). */
function FilesBody({ filters, go, reset }: BodyProps) {
  const t = useT();
  const list = useFiles(filters);
  if (list.isPending) return <LoadingRows label={t.files.loading} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.items.length === 0) {
    const filtered = activeFilterCount(filters) > 0 || filters.page > 1;
    return filtered ? <FilteredEmpty title={t.files.empty} body={t.files.emptyBody} onReset={reset} /> : <EmptyState title={t.files.emptyNone} body={t.files.emptyNoneBody} />;
  }
  const page = list.data;
  return (
    <div className={cn('flex flex-col gap-3 transition-opacity duration-(--fg-dur-fast)', list.isPlaceholderData && 'opacity-60')} aria-busy={list.isPlaceholderData}>
      <FilesTable rows={page.items} category={filters.category} sort={filters.sort} onSort={(sort) => go({ ...filters, sort, page: 1 })} />
      {page.partial && <p className="text-[13px] text-ink-2">{t.files.partial}</p>}
      <Pagination page={page.page} pageSize={page.pageSize} total={page.total} shown={page.items.length} hasMore={page.hasMore} onPage={(p) => go({ ...filters, page: p })} />
    </div>
  );
}

/** `/files?category=meter`: readings, not files, from `GET /meter-readings` (6c.4). */
function MeterReadingsBody({ filters, go }: BodyProps) {
  const t = useT();
  const m = t.files.meter;
  const list = useMeterReadings(filters);
  if (list.isPending) return <LoadingRows label={m.loading} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.items.length === 0) {
    // The category is the view itself here, so it is not one of the filters to reset.
    const filtered = activeFilterCount(filters) > 1 || filters.page > 1;
    return filtered ? (
      <FilteredEmpty title={m.empty} body={m.emptyBody} onReset={() => go({ ...DEFAULT_FILTERS, category: 'meter_readings' })} />
    ) : (
      <EmptyState title={m.emptyNone} body={m.emptyNoneBody} />
    );
  }
  const page = list.data;
  return (
    <div className={cn('flex flex-col gap-3 transition-opacity duration-(--fg-dur-fast)', list.isPlaceholderData && 'opacity-60')} aria-busy={list.isPlaceholderData}>
      <MeterReadingsTable rows={page.items} />
      <Pagination page={page.page} pageSize={page.pageSize} total={page.total} shown={page.items.length} hasMore={page.hasMore} onPage={(p) => go({ ...filters, page: p })} />
    </div>
  );
}

/**
 * SC-04 Fișiere (FE-03): filters live in the URL only, so every view is a shareable link. Search-param changes go
 * through the native History API, which Next integrates with `useSearchParams` without a server round trip. The
 * meter readings category shows the readings table variant instead of the files list.
 */
export function FilesScreen() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query]);
  const me = useMe().data;
  const categories = useMemo(() => FILE_CATEGORIES.filter((c) => can(me, VIEW[c])), [me]);

  const go = (next: FileFilters) => {
    const qs = toSearchParams(next).toString();
    window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
  };
  // Any filter change starts again from the first page.
  const change = (patch: Partial<FileFilters>) => go({ ...filters, ...patch, page: 1 });
  const reset = () => go(DEFAULT_FILTERS);

  return (
    <div className="flex flex-col gap-5">
      <FiltersBar filters={filters} categories={categories} onChange={change} onReset={reset} />
      {filters.category === 'meter_readings' ? <MeterReadingsBody filters={filters} go={go} reset={reset} /> : <FilesBody filters={filters} go={go} reset={reset} />}
    </div>
  );
}
