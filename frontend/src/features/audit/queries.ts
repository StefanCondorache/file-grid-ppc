'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { PageMeta, paths } from '@/lib/api/types';
import type { AuditFilters, AuditRow } from './types';
import { filtersToQuery } from './url';

export const AUDIT_PAGE_SIZE = 20;

type AuditQuery = paths['/audit-events']['get']['parameters']['query'];

/** GET /audit-events. `enabled: false` for roles without view_audit: no request is made at all. */
export function useAuditEvents(filters: AuditFilters, enabled: boolean) {
  return useQuery({
    queryKey: qk.audit({ ...filters }),
    // docs/api.md names the actor filter `actor`; the schema still says `userId` (backend accepts both).
    queryFn: async () =>
      (await unwrap(api.GET('/audit-events', { params: { query: filtersToQuery(filters, AUDIT_PAGE_SIZE) as AuditQuery } }))) as unknown as {
        data: AuditRow[];
        meta: PageMeta;
      },
    enabled,
    placeholderData: keepPreviousData,
  });
}
