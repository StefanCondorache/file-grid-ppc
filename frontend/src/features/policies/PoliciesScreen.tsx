'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { Card } from '@/components/ui/card';
import { useMe } from '@/features/auth/queries';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { formatBytes } from '@/lib/i18n/format';
import { STORAGE_LABEL } from './diff';
import { usePolicies } from './queries';
import { POLICY_CATEGORIES } from './schema';

export function PoliciesScreen() {
  const t = useT().policies;
  const me = useMe().data;
  const q = usePolicies();
  const editable = can(me, 'edit_policies');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] font-bold">{t.title}</h1>
        <p className="text-ink-2">{t.intro}</p>
      </header>
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      <div className="grid gap-4 md:grid-cols-2">
        {POLICY_CATEGORIES.map((c) => {
          const p = q.data?.find((x) => x.category === c);
          return (
            <Card key={c} className="flex flex-col gap-2">
              <h2 className="text-lg font-bold">{t.categories[c]}</h2>
              {p ? (
                <>
                  <p className="text-sm text-ink-2">
                    {STORAGE_LABEL[p.primaryStorage]} → {p.fallbackStorage ? STORAGE_LABEL[p.fallbackStorage] : t.noFallback} · {formatBytes(p.chunkSize)} × {p.maxParallel}
                    {p.encryptionAtRest ? ' · criptat' : ''} · {t.version(p.version)}
                  </p>
                  <Link className="font-semibold text-(--fg-link) underline" href={`/policies/${c}`}>{editable ? t.edit : t.view}</Link>
                </>
              ) : (
                <p className="text-ink-2">…</p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
