'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { KpiTile } from '@/components/KpiTile';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { announce } from '@/lib/a11y/announcer';
import { cn } from '@/lib/cn';
import { plural, useT } from '@/lib/i18n';
import type { CategoryId, GuaranteeState, GuaranteeStatus } from '@/lib/monitoring/contract';
import { FLAP_MS } from './announce';
import { MeterCounters } from './MeterCounters';
import { decimal, metricOf, percent, seconds, sentenceFor } from './sentences';

const TONE: Record<GuaranteeState, Tone> = { ok: 'ok', at_risk: 'warn', violated: 'crit' };

const CATEGORY_DOT: Record<CategoryId, string> = {
  meter_readings: 'bg-cat-meter',
  fault_records: 'bg-cat-fault',
  connection_documents: 'bg-cat-connection',
  drone_videos: 'bg-cat-drone',
};

const CARD_STATE: Record<GuaranteeState, string> = {
  ok: 'glass-card',
  at_risk: 'glass-card glass-warn',
  violated: 'glass-card glass-crit border-2 border-crit',
};

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit' });

/** Speaks a state change through the shared announcer: polite, `violated` assertive; silent on mount. */
function useStateAnnouncement(name: string, state: GuaranteeState) {
  const t = useT().monitoring;
  const spoken = useRef(state);
  useEffect(() => {
    if (state === spoken.current) return;
    const timer = setTimeout(() => {
      spoken.current = state;
      announce(t.stateChanged(name, t.states[state]), state === 'violated' ? 'assertive' : 'polite');
    }, FLAP_MS);
    return () => clearTimeout(timer);
  }, [name, state, t]);
}

/** The proving metric and its threshold, per guarantee (PRD FE-07). */
function Proof({ g }: { g: GuaranteeStatus }): ReactNode {
  const t = useT().monitoring;
  switch (g.category) {
    case 'meter_readings': {
      const value = (key: string) => metricOf(g, key).value;
      return <MeterCounters counters={{ received: value('received'), unique: value('unique'), duplicatesRejected: value('duplicatesRejected'), lost: value('lost') }} />;
    }
    case 'fault_records': {
      const { value, threshold } = metricOf(g, 'uploadToAvailableP95Ms');
      const target = threshold === null ? null : t.fault.target(seconds(threshold));
      const note = value === null ? [t.fault.noSamples, target].filter(Boolean).join(' · ') : target ?? undefined;
      return <KpiTile label={t.fault.kpi} value={value === null ? '—' : decimal(value / 1000)} unit={value === null ? undefined : 's'} note={note} />;
    }
    case 'connection_documents': {
      const pct = metricOf(g, 'encryptedPct');
      const reveals = metricOf(g, 'unmaskEventsToday');
      const lastCheck = g.metrics.find((m) => m.key === 'lastAuditCheckAt')?.value;
      const at = lastCheck ? new Date(lastCheck) : null;
      const meta = [
        reveals.value === null
          ? null
          : `${plural(reveals.value, t.connection.reveals)}${reveals.threshold === null ? '' : ` (${t.connection.revealLimit(decimal(reveals.threshold))})`}`,
        at && !Number.isNaN(at.getTime()) ? t.connection.lastCheck(clock.format(at)) : null,
      ].filter(Boolean);
      return (
        <>
          <KpiTile
            label={t.connection.kpi}
            value={pct.value === null ? '—' : decimal(pct.value)}
            unit={pct.value === null ? undefined : '%'}
            note={pct.threshold === null ? undefined : t.connection.target(percent(pct.threshold))}
          />
          {meta.length > 0 && <p className="text-sm text-ink-2">{meta.join(' · ')}</p>}
        </>
      );
    }
    case 'drone_videos': {
      const rate = metricOf(g, 'successRate');
      const count = (key: string) => decimal(metricOf(g, key).value ?? 0);
      const target = rate.threshold === null ? null : t.drone.target(percent(rate.threshold * 100));
      return (
        <>
          <KpiTile
            label={t.drone.kpi}
            value={rate.value === null ? '—' : decimal(rate.value * 100)}
            unit={rate.value === null ? undefined : '%'}
            note={(rate.value === null ? [t.drone.noTransfers, target] : [target]).filter(Boolean).join(' · ') || undefined}
          />
          <p className="text-sm text-ink-2">
            {[t.drone.completed(count('transfersCompleted')), t.drone.resumed(count('transfersResumed')), t.drone.failed(count('transfersFailed'))].join(' · ')}
          </p>
        </>
      );
    }
    default:
      return null;
  }
}

/**
 * One business guarantee (table 2.1): title, status chip (icon + word), the Romanian sentence and the proving metric
 * against its threshold. The state comes from the backend; the card never decides it.
 */
export function GuaranteeCard({ guarantee: g, headingLevel = 3 }: { guarantee: GuaranteeStatus; headingLevel?: 2 | 3 }) {
  const t = useT().monitoring;
  const titleId = useId();
  const name = t.categories[g.category];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  useStateAnnouncement(name, g.state);

  return (
    <article
      aria-labelledby={titleId}
      data-state={g.state}
      data-category={g.category}
      className={cn('relative flex h-full w-full flex-col gap-4 overflow-hidden rounded-hero tilt p-6 text-card-foreground', CARD_STATE[g.state])}
    >
      {g.state === 'violated' && <span data-status-edge aria-hidden="true" className="attention absolute inset-y-0 left-0 w-[6px] bg-crit" />}
      <div className="flex items-start justify-between gap-3">
        <Heading id={titleId} className="flex items-center gap-2 text-[17px] leading-7 font-bold">
          <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-[3px]', CATEGORY_DOT[g.category])} />
          {name}
        </Heading>
        <StatusChip tone={TONE[g.state]} label={t.states[g.state]} className="shrink-0" />
      </div>
      <p className="text-base">{sentenceFor(g)}</p>
      <Proof g={g} />
    </article>
  );
}
