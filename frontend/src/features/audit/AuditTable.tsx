import Link from 'next/link';
import { roleLabel } from '@/features/auth/roles';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { Tag } from '@/components/ui/tag';
import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import type { AuditOutcome, AuditRow } from './types';
import { filtersToParams } from './url';

const OUTCOME_TONE: Record<AuditOutcome, Tone> = { success: 'ok', failure: 'crit', denied: 'warn' };
const th = 'border-b border-border bg-surface-2 px-3 py-2 text-left font-semibold text-ink-2';
const td = 'border-b border-border px-3 py-2 align-top';
// 24 px minimum target (WCAG 2.5.8): links in a cell are stacked, never side by side.
const link = 'inline-flex min-h-6 items-center text-link underline';

/** Audit rows: cine / ce / când / motiv / rezultat / ID urmărire. Never shows personal data values. */
export function AuditTable({ events }: { events: AuditRow[] }) {
  const t = useT().audit;
  return (
    <div className="overflow-x-auto rounded-panel border border-border bg-surface" role="region" aria-label={t.caption}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>{t.columns.who}</th>
            <th scope="col" className={th}>{t.columns.what}</th>
            <th scope="col" className={th}>{t.columns.when}</th>
            <th scope="col" className={th}>{t.columns.reason}</th>
            <th scope="col" className={th}>{t.columns.outcome}</th>
            <th scope="col" className={th}>{t.columns.trace}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const outcome = e.outcome ?? 'success';
            return (
              <tr key={e.id}>
                <td className={td}>
                  <div className="font-semibold text-ink">{e.actor.displayName}</div>
                  <div className="text-ink-2">
                    {e.actor.username} · {roleLabel(e.actor.role)}
                  </div>
                  {e.actingAs ? (
                    <Tag className="mt-1">{t.demoRole(roleLabel(e.actingAs))}</Tag>
                  ) : (
                    e.demo && <Tag className="mt-1">{t.demo}</Tag>
                  )}
                </td>
                <td className={td}>
                  <div className="font-semibold text-ink">{t.action[e.action] ?? e.action}</div>
                  {e.fileId && (
                    <div className="flex flex-col items-start gap-1">
                      <Link href={`/files/${encodeURIComponent(e.fileId)}`} className={link}>
                        {e.fileDisplayName ?? e.fileId}
                      </Link>
                      <Link href={`/audit?${filtersToParams({ fileId: e.fileId })}`} className={link}>
                        {t.onlyThisFile}
                      </Link>
                    </div>
                  )}
                  {e.details && <div className="text-ink-2">{e.details}</div>}
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  <time dateTime={e.at}>{formatDateTime(e.at)}</time>
                  {e.clientIp && <div className="text-ink-2">{t.ip(e.clientIp)}</div>}
                </td>
                <td className={td}>{e.reason ?? <span className="text-ink-2">{t.noReason}</span>}</td>
                <td className={td}>
                  <StatusChip tone={OUTCOME_TONE[outcome]} label={t.outcome[outcome]} />
                </td>
                <td className={td}>
                  <Link href={`/traces/${encodeURIComponent(e.traceId)}`} className={`${link} font-mono`}>
                    {e.traceId}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
