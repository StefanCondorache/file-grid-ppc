'use client';

import { useCallback, useState } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { Forbidden } from '@/components/Forbidden';
import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/queries';
import { roleLabel } from '@/features/auth/roles';
import { ReportContext, useSimulator } from '@/features/demo/api';
import { SimulatorControl } from '@/features/demo/SimulatorControl';
import { MeterCounters } from '@/features/guarantees/MeterCounters';
import { announce } from '@/lib/a11y/announcer';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import { ro } from '@/lib/i18n/ro';
import type { MeterCounters as Counters } from '@/lib/monitoring/contract';
import { useMeterCounters } from './queries';
import { RateKpi } from './RateKpi';
import { RecentReadings } from './RecentReadings';
import { ZoneSplit } from './ZoneSplit';

/** The spoken summary of "Citește rezumatul": `1 284 532 primite, 0 pierdute`. */
export function summaryOf(c: Counters): string {
  const m = ro.meters;
  return c.lost === null ? m.summaryUnknown(formatInt(c.received)) : m.summary(formatInt(c.received), formatInt(c.lost));
}

/**
 * Contoare live (SC-04): the counters, the rate and zone split, and the newest readings. The numbers change every few
 * seconds and are never a live region (A11Y-17); "Citește rezumatul" says them on demand. Admins in demo mode also get
 * the simulator control.
 */
export function MetersScreen() {
  const t = useT();
  const me = useMe();
  const allowed = !!me.data && can(me.data, 'view_meters');
  const admin = !!me.data && me.data.demoMode && can(me.data, 'demo_controls');
  const counters = useMeterCounters();
  const simulator = useSimulator(allowed);
  const [result, setResult] = useState<string | null>(null);
  const report = useCallback((ok: boolean, text: string) => {
    setResult(text);
    announce(text, ok ? 'polite' : 'assertive');
  }, []);

  if (me.data && !allowed) return <Forbidden roleLabel={roleLabel(me.data.activeRole)} />;

  const c = counters.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 className="text-[22px] font-bold">{t.meters.title}</h2>
        </div>
        <Button variant="secondary" disabled={!c} onClick={() => c && announce(summaryOf(c), 'polite')}>
          {t.meters.readSummary}
        </Button>
      </div>

      {counters.isError && !c ? (
        <ErrorState error={counters.error} onRetry={() => void counters.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RateKpi ratePerS={c?.ratePerS ?? null} simulator={simulator.data} />
          <section aria-labelledby="counters-title" data-testid="meter-counters" className="flex flex-col gap-2 rounded-card border border-border bg-card p-5 shadow-e1">
            <h3 id="counters-title" className="text-lg font-bold">
              {t.meters.countersTitle}
            </h3>
            <MeterCounters counters={{ received: c?.received ?? null, unique: c?.unique ?? null, duplicatesRejected: c?.duplicatesRejected ?? null, lost: c ? c.lost : null }} />
          </section>
          <ZoneSplit byZone={c?.byZone ?? []} />
        </div>
      )}

      {admin && (
        <ReportContext.Provider value={report}>
          <div className="flex flex-col gap-2">
            <SimulatorControl simulator={simulator.data} unavailable={simulator.isError} />
            {result && <p className="text-sm text-ink-2">{result}</p>}
          </div>
        </ReportContext.Provider>
      )}

      <RecentReadings />
    </div>
  );
}
