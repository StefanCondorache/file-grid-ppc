'use client';

import { useEffect, useState } from 'react';
import { StatusChip } from '@/components/ui/status-chip';
import { Button } from '@/components/ui/button';
import { decimal } from '@/features/guarantees/sentences';
import { announce } from '@/lib/a11y/announcer';
import { useT } from '@/lib/i18n';
import type { SimulatorStatus } from '@/lib/monitoring/contract';
import { call, toSimulator, useRunAction, type DemoStatus } from './api';
import { ConfirmAction } from './ConfirmAction';
import { Panel } from './Panel';

const DURATIONS = ['60', '120', '300'] as const;

/** `01:12` from a number of milliseconds (never negative). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The visual countdown is aria-hidden (a ticking live region would flood a screen reader); "Cât a mai rămas?" says it
 * on demand.
 */
function Countdown({ endsAt }: { endsAt: string }) {
  const t = useT().demo.storm;
  const end = Date.parse(endsAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, end - now);
  const say = () => {
    const s = Math.ceil(left / 1000);
    announce(t.remainingSay(Math.floor(s / 60), s % 60), 'polite');
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-ink-2">{t.remaining}</span>
      <span aria-hidden="true" data-testid="storm-countdown" className="text-3xl font-bold tabular-nums">
        {mmss(left)}
      </span>
      <Button variant="quiet" size="sm" onClick={say}>
        {t.askRemaining}
      </Button>
    </div>
  );
}

/** Storm on meter readings (POST/DELETE /demo/storms): the real backend storms the simulator only (rate × STORM_FACTOR). */
export function StormControl({ status, simulator }: { status: DemoStatus | undefined; simulator: SimulatorStatus | null | undefined }) {
  const t = useT().demo;
  const run = useRunAction();
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]>('120');
  const storm = status?.storm ?? (simulator?.mode === 'peak' ? { category: 'meter_readings', endsAt: simulator.stormEndsAt } : null);
  const rate = (s: unknown) => decimal(toSimulator(s)?.ratePerS ?? 0);

  return (
    <Panel id="storm-title" title={t.storm.title} lead={t.storm.lead}>
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip tone={storm ? 'warn' : 'neutral'} label={storm ? t.storm.active : t.storm.inactive} />
        {simulator && <span className="text-sm tabular-nums text-ink-2">{t.simulator.current(t.simulator.modes[simulator.mode], decimal(simulator.ratePerS))}</span>}
      </div>
      {storm?.endsAt ? <Countdown key={storm.endsAt} endsAt={storm.endsAt} /> : storm ? <p className="text-sm text-ink-2">{t.storm.noEnd}</p> : null}
      <label className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {t.storm.duration}
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value as (typeof DURATIONS)[number])}
          className="h-10 rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink"
        >
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {t.storm.durations[d]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-3">
        <ConfirmAction
          variant="primary"
          label={t.storm.start}
          title={t.storm.confirmStartTitle}
          body={t.storm.confirmStartBody(t.storm.durations[duration])}
          disabled={!!storm}
          onConfirm={() => run(() => call('POST', '/demo/storms', { category: 'meter_readings', durationS: Number(duration) }), (r) => t.storm.started(rate(r)))}
        />
        <ConfirmAction
          variant="danger"
          label={t.storm.stop}
          title={t.storm.confirmStopTitle}
          body={t.storm.confirmStopBody}
          onConfirm={() => run(() => call('DELETE', '/demo/storms/meter_readings'), (r) => t.storm.stopped(rate(r)))}
        />
      </div>
    </Panel>
  );
}
