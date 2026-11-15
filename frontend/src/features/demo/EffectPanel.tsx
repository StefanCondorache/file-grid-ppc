'use client';

import { GuaranteesBoard } from '@/features/guarantees/GuaranteesBoard';
import { StorageHealthStrip } from '@/features/health/StorageHealthStrip';
import { BulkheadChart } from '@/features/observability/BulkheadChart';
import { useT } from '@/lib/i18n';

/** The same-screen effect (FE-12): the guarantee cards, the storage strip and the bulkhead chart, all live. */
export function EffectPanel() {
  const t = useT().demo.effect;
  return (
    <section aria-labelledby="effect-title" data-testid="effect-panel" className="flex flex-col gap-6 rounded-hero glass-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="effect-title" className="text-[22px] font-bold">
            {t.title}
          </h2>
          <p className="text-ink-2">{t.lead}</p>
        </div>
        <StorageHealthStrip />
      </div>
      <GuaranteesBoard />
      <BulkheadChart initialWindow="5m" />
    </section>
  );
}
