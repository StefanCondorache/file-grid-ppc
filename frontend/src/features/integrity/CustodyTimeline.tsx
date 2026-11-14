'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { Tag } from '@/components/ui/tag';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatDateTime, formatInt } from '@/lib/i18n/format';

/** One custody event as `GET /files/{id}/custody` sends it (backend files.service.ts `custody`, oldest first). */
export type CustodyEvent = {
  id: string;
  type: string;
  at: string;
  actor: { id: string; username: string; displayName: string; role: string | null } | null;
  /** The role a person acted as through the demo role switch, else null. */
  actingAs: string | null;
  demo: boolean;
  storage: string | null;
  policyVersion: number | null;
  reason: string | null;
  traceId: string | null;
};

export async function fetchCustody(fileId: string): Promise<CustodyEvent[]> {
  // The path follows docs/api.md; the generated proposal types differ, so the body is checked here.
  const body = (await unwrap(api.GET('/files/{fileId}/custody', { params: { path: { fileId } } }))) as unknown as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected custody from the server');
  return body.data as CustodyEvent[];
}

export function useCustody(fileId: string) {
  return useQuery({ queryKey: qk.files.custody(fileId), queryFn: () => fetchCustody(fileId) });
}

/** Newest first; ties keep the server's order reversed, so a later event of the same instant stays on top. */
export function newestFirst(events: readonly CustodyEvent[]): CustodyEvent[] {
  return events
    .map((e, i) => ({ e, i, at: Date.parse(e.at) || 0 }))
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .map((x) => x.e);
}

const SYSTEM_ACTOR = /^(system|meter|demo):/;
const CRIT_TYPES = new Set(['corruption_detected', 'demo_corrupted']);

/**
 * The chain of custody of a file (FE-06): every event from the audit trail, newest first, with who did it, the demo
 * role they acted as, the reason given for a personal-data reveal and a link to the trace of the operation.
 */
export function CustodyTimeline({ fileId }: { fileId: string }) {
  const t = useT();
  const c = t.files.custody;
  const query = useCustody(fileId);
  if (query.isPending) {
    return (
      <p aria-busy="true" className="text-sm text-ink-2">
        {c.loading}
      </p>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const events = newestFirst(query.data);
  if (events.length === 0) return <p className="text-sm text-ink-2">{c.empty}</p>;
  const roles = t.auth.roles as Record<string, { label: string } | undefined>;
  return (
    <ol className="flex flex-col">
      {events.map((e) => {
        const username = e.actor?.displayName ?? e.actor?.username ?? null;
        const actor = !username || SYSTEM_ACTOR.test(username) ? c.system : username;
        const actingAs = e.actingAs ? (roles[e.actingAs]?.label ?? e.actingAs) : null;
        const storage = e.storage ? (t.files.storage[e.storage as keyof typeof t.files.storage] ?? e.storage.toUpperCase()) : null;
        return (
          <li key={e.id} data-type={e.type} className="flex flex-col gap-1 border-l-2 border-border py-2.5 pl-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={cn('font-semibold', CRIT_TYPES.has(e.type) && 'text-crit-ink')}>{c.types[e.type] ?? e.type}</span>
              <time dateTime={e.at} className="text-sm text-ink-2 tabular-nums">
                {formatDateTime(e.at)}
              </time>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span dir="auto" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
                {actor}
              </span>
              {actingAs && (
                <>
                  <Tag>{c.demoRole}</Tag>
                  <span className="text-ink-2">{c.actingAs(actingAs)}</span>
                </>
              )}
              {e.type === 'stored' && storage && e.policyVersion !== null && (
                <span className="text-ink-2">{c.storedOn(storage, formatInt(e.policyVersion))}</span>
              )}
              {e.traceId && (
                <Link href={`/traces/${encodeURIComponent(e.traceId)}`} className="font-semibold text-link hover:underline">
                  {c.trace}
                </Link>
              )}
            </div>
            {e.reason && (
              <p className="text-sm">
                <span className="text-ink-2">{c.reason}</span>{' '}
                <span dir="auto" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
                  {e.reason}
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
