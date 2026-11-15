'use client';

import { SafeName } from '@/components/SafeName';
import { Tag } from '@/components/ui/tag';
import { roleLabel } from '@/features/auth/roles';
import type { AuditEvent, Role } from '@/lib/api/types';
import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';

/** The real API sends more than the OpenAPI proposal (docs/api.md wins). */
export type AuditRow = Omit<AuditEvent, 'actingAs'> & { actingAs?: Role | null; outcome?: string | null; category?: string | null; clientIp?: string | null };

export function AuditTable({ events }: { events: AuditRow[] }) {
  const t = useT();
  const a = t.audit;
  const actions = a.actions as Record<string, string>;
  const outcomes = a.outcomes as Record<string, string>;
  return (
    <div className="overflow-x-auto rounded-panel glass-dense">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption className="sr-only">{a.tableLabel}</caption>
        <thead className="bg-surface-2 text-ink-2">
          <tr>
            {[a.columns.who, a.columns.what, a.columns.when, a.columns.reason, a.columns.trace].map((c) => (
              <th key={c} scope="col" className="px-3 py-2 font-semibold">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-t border-border align-top">
              <td className="px-3 py-2">
                <div className="font-semibold">{e.actor.displayName}</div>
                <div className="text-ink-2">{roleLabel(e.actor.role)}</div>
                {e.actingAs && <Tag className="mt-1">{a.actingAs(roleLabel(e.actingAs))}</Tag>}
                {e.clientIp && <div className="mt-1 font-mono text-xs text-ink-2" aria-label={a.columns.ip}>{e.clientIp}</div>}
              </td>
              <td className="px-3 py-2">
                <div>{actions[e.action] ?? e.action}</div>
                {e.outcome && e.outcome !== 'success' && <div className="text-crit-ink">{outcomes[e.outcome] ?? e.outcome}</div>}
                {e.fileDisplayName && <div className="text-ink-2"><SafeName name={e.fileDisplayName} /></div>}
                {e.details && <div className="text-ink-2">{e.details}</div>}
              </td>
              <td className="whitespace-nowrap px-3 py-2"><time dateTime={e.at}>{formatDateTime(e.at)}</time></td>
              <td className="px-3 py-2">{e.reason ?? a.noReason}</td>
              <td className="px-3 py-2 font-mono text-xs">{e.traceId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
