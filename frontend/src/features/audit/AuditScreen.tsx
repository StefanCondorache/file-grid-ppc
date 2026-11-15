'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Forbidden } from '@/components/Forbidden';
import { Button } from '@/components/ui/button';
import { roleLabel } from '@/features/auth/roles';
import { useMe } from '@/features/auth/queries';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { AuditFilters, type AuditFilterValues } from './AuditFilters';
import { AuditTable, type AuditRow } from './AuditTable';

const PAGE_SIZE = 50;
const KEYS = ['action', 'actor', 'fileId', 'from', 'to'] as const;

/** Local day bounds so a date filter covers the whole day. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export function AuditScreen() {
  const t = useT();
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const values = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as AuditFilterValues;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const allowed = can(me.data, 'view_audit');

  const filters = { action: values.action || undefined, actor: values.actor.trim() || undefined, fileId: values.fileId.trim() || undefined, from: dayStart(values.from), to: dayEnd(values.to), page, pageSize: PAGE_SIZE };
  const list = useQuery({
    queryKey: qk.audit(filters),
    enabled: allowed,
    queryFn: () => unwrap(api.GET('/audit-events', { params: { query: filters as never } })) as Promise<{ data: AuditRow[]; meta: { total: number; hasMore: boolean } }>,
  });

  // router.replace updates the URL asynchronously: a second change before the re-render builds on
  // the query pushed last, not on the render's params (else picking an action, then a file id, lost the action).
  const pushed = useRef<string | null>(null);
  const current = params.toString();
  useEffect(() => {
    pushed.current = null;
  }, [current]);
  const push = (next: Record<string, string>) => {
    const q = new URLSearchParams(pushed.current ?? current);
    for (const [k, v] of Object.entries(next)) { if (v) q.set(k, v); else q.delete(k); }
    const s = q.toString();
    pushed.current = s;
    router.replace(s ? `${pathname}?${s}` : pathname);
  };

  if (me.isPending) return <p role="status">{t.common.loading}</p>;
  if (me.data && !allowed) return <Forbidden roleLabel={roleLabel(me.data.activeRole)} />;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="audit-title">
      <div>
        <h2 id="audit-title" className="text-[22px] font-bold">{t.audit.title}</h2>
      </div>
      <AuditFilters values={values} onChange={(patch) => push({ ...patch, page: '' })} />
      {list.isPending && <p role="status">{t.common.loading}</p>}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && (list.data.data.length === 0
        ? <EmptyState title={t.audit.empty} />
        : (
          <>
            <AuditTable events={list.data.data} />
            <nav className="flex items-center gap-3" aria-label={t.audit.tableLabel}>
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => push({ page: page > 2 ? String(page - 1) : '' })}>{t.audit.prev}</Button>
              <span className="text-sm text-ink-2">{t.audit.page(page)} · {t.audit.total(list.data.meta.total)}</span>
              <Button variant="secondary" size="sm" disabled={!list.data.meta.hasMore} onClick={() => push({ page: String(page + 1) })}>{t.audit.next}</Button>
            </nav>
          </>
        ))}
    </section>
  );
}
