'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import { useRecentReadings } from './queries';

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const kwh = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** The newest readings, each linked to the JSONL batch file that stores it (file detail). */
export function RecentReadings() {
  const t = useT();
  const m = t.meters;
  const readings = useRecentReadings();

  let body;
  if (readings.data) {
    body =
      readings.data.length === 0 ? (
        <p className="text-ink-2">{m.noReadings}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">{m.recentCaption}</caption>
            <thead>
              <tr>
                {(['receivedAt', 'meter', 'zone', 'kwh', 'sequence', 'storage', 'file'] as const).map((k) => (
                  <th key={k} scope="col" className={`border-b border-border bg-surface-2 px-3 py-2 font-semibold text-ink-2 ${k === 'kwh' || k === 'sequence' ? 'text-right' : 'text-left'}`}>
                    {m.columns[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {readings.data.map((r, i) => {
                const seq = r.sequence === null ? '—' : formatInt(r.sequence);
                return (
                  <tr key={`${r.meterId}-${r.sequence ?? i}-${i}`}>
                    <td className="border-b border-border px-3 py-2 tabular-nums">{r.receivedAt ? clock.format(new Date(r.receivedAt)) : '—'}</td>
                    <td className="border-b border-border px-3 py-2 font-mono">{r.meterId}</td>
                    <td className="border-b border-border px-3 py-2">{r.zone ? (t.live.zones[r.zone] ?? r.zone) : '—'}</td>
                    <td className="border-b border-border px-3 py-2 text-right tabular-nums">{r.kwh === null ? '—' : kwh.format(r.kwh)}</td>
                    <td className="border-b border-border px-3 py-2 text-right tabular-nums">{seq}</td>
                    <td className="border-b border-border px-3 py-2">{(t.demo.storages as Record<string, string>)[r.storage] ?? r.storage}</td>
                    <td className="border-b border-border px-3 py-2">
                      {r.fileId ? (
                        <Link href={`/files/${r.fileId}`} className="font-semibold text-link underline" aria-label={m.openFileLabel(r.meterId, seq)}>
                          {m.openFile}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
  } else if (readings.isError) {
    body = <ErrorState error={readings.error} onRetry={() => void readings.refetch()} />;
  } else {
    body = <div aria-hidden="true" className="h-40 animate-pulse rounded-panel bg-surface-2 motion-reduce:animate-none" />;
  }

  return (
    <section aria-labelledby="recent-title" aria-busy={readings.isPending} className="flex flex-col gap-3 rounded-card border border-border bg-card p-5 shadow-e1">
      <h3 id="recent-title" className="text-lg font-bold">
        {m.recentTitle}
      </h3>
      {body}
    </section>
  );
}
