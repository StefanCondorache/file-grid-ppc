'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Forbidden } from '@/components/Forbidden';
import { Button } from '@/components/ui/button';
import { roleLabel } from '@/features/auth/roles';
import type { Me } from '@/lib/api/types';
import { can } from '@/lib/auth/capabilities';
import { plural, useT } from '@/lib/i18n';
import { AuditFilters } from './AuditFilters';
import { AuditTable } from './AuditTable';
import { AUDIT_PAGE_SIZE, useAuditEvents } from './queries';
import type { AuditFilters as Filters } from './types';
import { filtersFromParams, filtersToParams } from './url';

/** Audit trail (FE 6h.1). Filters and page live in the URL; roles without view_audit never fetch. */
export function AuditScreen({ me }: { me: Me }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const filters = filtersFromParams(new URLSearchParams(useSearchParams().toString()));
  const allowed = can(me, 'view_audit');
  const query = useAuditEvents(filters, allowed);

  if (!allowed) {
    return (
      <div className="flex flex-col gap-3">
        <Forbidden roleLabel={roleLabel(me.activeRole)} />
        <p className="text-ink-2">{t.audit.forbidden}</p>
      </div>
    );
  }

  const href = (f: Filters) => {
    const qs = filtersToParams(f).toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };
  const page = filters.page ?? 1;
  const meta = query.data?.meta;
  const pages = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-5">
      {/* The shell's top bar already renders the page title as the h1. */}
      <p className="text-ink-2">{t.audit.intro}</p>
      <AuditFilters value={filters} onApply={(f) => router.replace(href({ ...f, page: 1 }))} />
      {query.isPending ? (
        <p role="status" className="text-ink-2">
          {t.common.loading}
        </p>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState title={t.audit.emptyTitle} body={t.audit.emptyBody} />
      ) : (
        <>
          <AuditTable events={query.data.data} />
          <nav aria-label={t.audit.pagination.label} className="flex flex-wrap items-center gap-3">
            <p role="status" className="text-sm text-ink-2">
              {t.audit.pagination.status(page, pages, plural(meta!.total, t.audit.pagination.total))}
            </p>
            {page > 1 && (
              <Button asChild variant="secondary" size="sm">
                <Link href={href({ ...filters, page: page - 1 })}>{t.audit.pagination.prev}</Link>
              </Button>
            )}
            {meta!.hasMore && (
              <Button asChild variant="secondary" size="sm">
                <Link href={href({ ...filters, page: page + 1 })}>{t.audit.pagination.next}</Link>
              </Button>
            )}
          </nav>
        </>
      )}
    </div>
  );
}

export { AUDIT_PAGE_SIZE };
