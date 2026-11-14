'use client';

import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n';
import { usePolicyHistory } from './queries';
import type { PolicyCategory } from './schema';

export function VersionHistory({ category }: { category: PolicyCategory }) {
  const t = useT().policies;
  const q = usePolicyHistory(category);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="history-title">
      <h2 id="history-title" className="text-lg font-bold">{t.history}</h2>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <p className="text-ink-2">{t.historyEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((v) => (
            <li key={v.version} className="rounded-panel border border-border bg-surface-2 p-3 text-sm">
              <strong>v{v.version}</strong> · {formatDateTime(v.changedAt)} · {v.changedBy.displayName}
              <ul className="mt-1 list-disc pl-5 text-ink-2">
                {v.changes.map((c) => (
                  <li key={c.field}>{c.field}: {c.from ?? '–'} → {c.to ?? '–'}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
