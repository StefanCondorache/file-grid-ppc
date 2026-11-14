'use client';

import { RefreshCw } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { z } from 'zod';
import { ErrorState } from '@/components/ErrorState';
import { Forbidden } from '@/components/Forbidden';
import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/queries';
import { roleLabel } from '@/features/auth/roles';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { GridInsights } from './GridInsights';
import { PeriodComparison } from './PeriodComparison';
import { PeriodPicker, pickPeriods, type PeriodChoice } from './PeriodPicker';
import { usePeriods, useRefreshStatistics } from './queries';
import { StorageFit } from './StorageFit';

/** SC-08 URL state (FE-03): the compared periods by id. Anything malformed is ignored; unknown ids fall back later. */
const periodParam = z.string().regex(/^[\w.:-]{1,128}$/).optional().catch(undefined);
const urlState = z.object({ periodA: periodParam, periodB: periodParam });

/** `/statistics` (SC-08, beat 8): answers for decision-makers, gated by `view_statistics`. */
export function StatisticsScreen() {
  const { data: me } = useMe();
  if (!me) return null;
  if (!can(me, 'view_statistics')) return <Forbidden roleLabel={roleLabel(me.activeRole)} />;
  return <Statistics />;
}

function Statistics() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const periods = usePeriods();
  const refresh = useRefreshStatistics();
  const url = urlState.parse({ periodA: params.get('periodA') ?? undefined, periodB: params.get('periodB') ?? undefined });
  const choice = pickPeriods(periods.data ?? [], { a: url.periodA, b: url.periodB });

  function choose(next: PeriodChoice) {
    const query = new URLSearchParams(params.toString());
    for (const [key, id] of [['periodA', next.a], ['periodB', next.b]] as const) {
      if (id) query.set(key, id);
      else query.delete(key);
    }
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-prose flex-col gap-1">
          <h2 className="text-[22px] font-bold">{t.statistics.screen.title}</h2>
          <p className="text-ink-2">{t.statistics.screen.lead}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {periods.data && <PeriodPicker periods={periods.data} value={choice} onChange={choose} />}
          <Button variant="secondary" size="md" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" />
            {t.statistics.screen.refresh}
          </Button>
        </div>
      </div>
      {periods.isError && <ErrorState error={periods.error} onRetry={() => void periods.refetch()} />}
      <StorageFit />
      <PeriodComparison a={choice.a} b={choice.b} />
      <GridInsights />
    </div>
  );
}
