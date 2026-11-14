'use client';

import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { useT } from '@/lib/i18n';
import { GuaranteeCard } from './GuaranteeCard';
import { useGuarantees } from './queries';

/** "Garanții de business" (SC-02, FE-07): the four guarantee cards, live. */
export function GuaranteesBoard() {
  const t = useT();
  const guarantees = useGuarantees();

  let body;
  if (guarantees.data) {
    body =
      guarantees.data.length === 0 ? (
        <EmptyState title={t.common.emptyTitle} body={t.monitoring.boardEmpty} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {guarantees.data.map((g) => (
            <li key={g.category} className="flex">
              <GuaranteeCard guarantee={g} />
            </li>
          ))}
        </ul>
      );
  } else if (guarantees.isError) {
    body = <ErrorState error={guarantees.error} onRetry={() => void guarantees.refetch()} />;
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <span className="sr-only">{t.common.loading}</span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} aria-hidden="true" className="h-64 animate-pulse rounded-hero border border-border bg-surface-2 motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="board-title" aria-busy={guarantees.isPending} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="board-title" className="text-[22px] font-bold">
          {t.monitoring.boardTitle}
        </h2>
        <p className="text-ink-2">{t.monitoring.boardLead}</p>
      </div>
      {body}
    </section>
  );
}
