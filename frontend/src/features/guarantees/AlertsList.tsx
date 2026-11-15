'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import type { Alert } from '@/lib/monitoring/contract';
import { Acknowledgement, timeOf } from './Acknowledgement';
import { useAlerts } from './queries';
import { sentenceFor } from './sentences';

const TONE: Record<Alert['state'], Tone> = { at_risk: 'warn', violated: 'crit', resolved: 'ok' };

/** The cause in words, from the facts the alert kept (a resolved alert keeps the cause it was raised with). */
function causeOf(a: Alert): string {
  return sentenceFor({
    category: a.category,
    state: a.state === 'resolved' ? 'at_risk' : a.state,
    causeCode: a.causeCode,
    causeFacts: a.causeFacts,
    metrics: [],
    updatedAt: a.raisedAt,
  });
}

const th = 'border-b border-border bg-surface-2 px-4 py-2.5 text-left text-[13px] font-semibold text-ink-2';
const td = 'border-b border-border px-4 py-3 align-top';

/**
 * The alerts of the four guarantees (FE-07), newest first, as a real table: when it was raised (and resolved), which
 * guarantee, its state, the cause in words, the trace, and who acknowledged it and when, or the button that does.
 * It reads the same cache as the banner, which the live stream keeps fresh.
 */
export function AlertsList() {
  const t = useT();
  const m = t.monitoring;
  const alerts = useAlerts();

  let body;
  if (alerts.data) {
    body =
      alerts.data.length === 0 ? (
        <p className="rounded-panel glass-card glass-empty p-6 text-ink-2">{m.alerts.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-card glass-dense">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{m.alerts.caption}</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>{m.alerts.columns.raisedAt}</th>
                <th scope="col" className={th}>{m.alerts.columns.guarantee}</th>
                <th scope="col" className={th}>{m.alerts.columns.state}</th>
                <th scope="col" className={th}>{m.alerts.columns.cause}</th>
                <th scope="col" className={th}>{m.alerts.columns.trace}</th>
                <th scope="col" className={th}>{m.alerts.columns.acknowledged}</th>
              </tr>
            </thead>
            <tbody>
              {alerts.data.map((a) => {
                const name = m.categories[a.category];
                const resolved = a.state === 'resolved' ? timeOf(a.resolvedAt) : null;
                return (
                  <tr key={a.id} data-state={a.state}>
                    <td className={`${td} whitespace-nowrap`}>
                      <time dateTime={a.raisedAt}>{formatDateTime(a.raisedAt)}</time>
                      {resolved && <div className="text-[13px] text-ink-2">{m.alerts.resolvedAt(resolved)}</div>}
                    </td>
                    <td className={`${td} font-semibold whitespace-nowrap`}>{name}</td>
                    <td className={td}>
                      <StatusChip tone={TONE[a.state]} label={m.alerts.states[a.state]} />
                    </td>
                    <td className={`${td} min-w-64`}>{causeOf(a)}</td>
                    <td className={td}>
                      {a.traceId ? (
                        <Link href={`/traces/${encodeURIComponent(a.traceId)}`} className="font-mono text-[13px] text-link underline underline-offset-2">
                          {a.traceId}
                        </Link>
                      ) : (
                        m.alerts.noTrace
                      )}
                    </td>
                    <td className={td}>
                      <Acknowledgement alert={a} guarantee={name} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
  } else if (alerts.isError) {
    body = <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />;
  } else {
    body = (
      <div aria-hidden="true" className="h-32 skeleton rounded-card glass-card" />
    );
  }

  return (
    <section aria-labelledby="alerts-title" aria-busy={alerts.isPending} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="alerts-title" className="text-[22px] font-bold">
          {m.alerts.listTitle}
        </h2>
      </div>
      {alerts.isPending && <span className="sr-only">{t.common.loading}</span>}
      {body}
    </section>
  );
}
