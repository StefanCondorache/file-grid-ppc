'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/ErrorState';
import { useMe } from '@/features/auth/queries';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import { PolicyForm } from './PolicyForm';
import { usePolicy } from './queries';
import type { PolicyCategory } from './types';
import { VersionHistory } from './VersionHistory';

/** One category: edit (admin) or read-only view, plus the version history. */
export function PolicyScreen({ category }: { category: PolicyCategory }) {
  const t = useT().policies;
  const me = useMe();
  const policy = usePolicy(category);
  const canEdit = can(me.data, 'edit_policies');

  return (
    <div className="flex flex-col gap-6">
      <Link href="/policies" className="text-sm font-semibold text-link underline">{t.back}</Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-[26px] font-bold">{t.category[category]}</h1>
        {policy.data && (
          <p className="text-ink-2">
            {t.version(policy.data.version)}
            {policy.data.updatedBy && ` · ${t.updated(policy.data.updatedBy.displayName, formatDateTime(policy.data.updatedAt))}`}
          </p>
        )}
      </header>
      {policy.error && <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />}
      {policy.data && me.data && (
        <section aria-label={canEdit ? t.edit : t.view} className="rounded-card border border-border bg-card p-6 shadow-e1">
          <PolicyForm policy={policy.data} canEdit={canEdit} />
        </section>
      )}
      <VersionHistory category={category} />
    </div>
  );
}
