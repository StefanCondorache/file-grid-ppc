'use client';

import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import { describeChange } from './diff';
import { usePolicyVersions } from './queries';
import type { PolicyCategory } from './types';

/** GET /policies/{category}/versions, newest first. */
export function VersionHistory({ category }: { category: PolicyCategory }) {
  const t = useT().policies.history;
  const versions = usePolicyVersions(category);
  return (
    <section aria-labelledby="policy-history" className="flex flex-col gap-3">
      <h2 id="policy-history" className="text-lg font-bold">{t.title}</h2>
      {versions.data?.length === 0 && <p className="text-ink-2">{t.empty}</p>}
      <ol className="flex flex-col gap-3">
        {versions.data?.map((v) => (
          <li key={v.version} className="rounded-panel border border-border bg-surface p-4">
            <p className="font-semibold">
              v{v.version} <span className="font-normal text-ink-2">· {t.by(v.changedBy?.displayName ?? '—', formatDateTime(v.changedAt))}</span>
            </p>
            {v.changes.length === 0 ? (
              <p className="text-sm text-ink-2">{t.created}</p>
            ) : (
              <ul className="text-sm">
                {v.changes.map((c) => {
                  const row = describeChange(c);
                  return <li key={c.field}>{row.field}: {row.from} → {row.to}</li>;
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
