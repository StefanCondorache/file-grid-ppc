'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { useT } from '@/lib/i18n';
import { formatValue } from './diff';
import { usePolicies } from './queries';

/** All categories at a glance; each card opens the category's policy. */
export function PoliciesScreen() {
  const t = useT().policies;
  const policies = usePolicies();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[26px] font-bold">{t.title}</h1>
        <p className="text-ink-2">{t.intro}</p>
      </header>
      {policies.error && <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />}
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {policies.data?.map((p) => (
          <li key={p.category} className="flex flex-col gap-3 rounded-card border border-border bg-card p-5 shadow-e1">
            <h2 className="text-lg font-bold">
              <Link href={`/policies/${p.category}`} className="underline-offset-4 hover:underline">{t.category[p.category]}</Link>
            </h2>
            <p className="text-sm text-ink-2">{t.version(p.version)}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-ink-2">{t.field.primaryStorage}</dt>
              <dd className="font-semibold">{formatValue('primaryStorage', p.primaryStorage)}</dd>
              <dt className="text-ink-2">{t.field.fallbackStorage}</dt>
              <dd className="font-semibold">{formatValue('fallbackStorage', p.fallbackStorage)}</dd>
              <dt className="text-ink-2">{t.field.encryptionAtRest}</dt>
              <dd className="font-semibold">{formatValue('encryptionAtRest', p.encryptionAtRest)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
