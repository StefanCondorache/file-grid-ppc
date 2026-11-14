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
import { useFiles } from './queries';

const VIEW: Record<FileCategoryId, Capability> = {
  fault_records: 'view_fault', drone_videos: 'view_drone', connection_documents: 'view_connection', meter_readings: 'view_meters',
};

function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage(page: number): void }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={t.files.pagination} className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-ink-2 tabular-nums">{t.files.showing(formatInt(from), formatInt(to), formatInt(total))}</p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="px-2.5" aria-label={t.files.prev} title={t.files.prev} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-sm font-semibold tabular-nums">{t.files.pageOf(formatInt(page), formatInt(pages))}</span>
        <Button variant="secondary" size="sm" className="px-2.5" aria-label={t.files.next} title={t.files.next} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function LoadingRows() {
  const t = useT();
  return (
    <div aria-busy="true" className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
      <span className="sr-only">{t.files.loading}</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-10 rounded-control bg-sunken" />
      ))}
    </div>
  );
}

/**
 * SC-04 Fișiere (FE-03): filters live in the URL only, so every view is a shareable link. Search-param changes go
 * through the native History API, which Next integrates with `useSearchParams` without a server round trip.
 */
export function FilesScreen() {
  const t = useT();
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query]);
  const me = useMe().data;
  const categories = useMemo(() => FILE_CATEGORIES.filter((c) => can(me, VIEW[c])), [me]);
  const list = useFiles(filters);

  const go = (next: FileFilters) => {
    const qs = toSearchParams(next).toString();
    window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
  };
  // Any filter change starts again from the first page.
  const change = (patch: Partial<FileFilters>) => go({ ...filters, ...patch, page: 1 });
  const reset = () => go(DEFAULT_FILTERS);
  const filtered = activeFilterCount(filters) > 0 || filters.page > 1;

  let body;
  if (list.isPending) body = <LoadingRows />;
  else if (list.isError) body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  else if (list.data.items.length === 0) {
    body = filtered ? (
      <EmptyState
        title={t.files.empty}
        body={t.files.emptyBody}
        action={
          <Button variant="secondary" size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" />
            {t.files.filters.reset}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t.files.emptyNone} body={t.files.emptyNoneBody} />
    );
  } else {
    const page = list.data;
    body = (
      <div className={cn('flex flex-col gap-3 transition-opacity duration-(--fg-dur-fast)', list.isPlaceholderData && 'opacity-60')} aria-busy={list.isPlaceholderData}>
        <FilesTable rows={page.items} category={filters.category} sort={filters.sort} onSort={(sort) => go({ ...filters, sort, page: 1 })} />
        {page.partial && <p className="text-[13px] text-ink-2">{t.files.partial}</p>}
        <Pagination page={page.page} pageSize={page.pageSize} total={page.total} onPage={(p) => go({ ...filters, page: p })} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <FiltersBar filters={filters} categories={categories} onChange={change} onReset={reset} />
      {body}
    </div>
  );
}
