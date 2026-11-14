'use client';

import { decimal } from '@/features/guarantees/sentences';
import { useT } from '@/lib/i18n';
import type { SimulatorMode, SimulatorStatus } from '@/lib/monitoring/contract';
import { call, toSimulator, useRunAction } from './api';
import { ConfirmAction } from './ConfirmAction';
import { Panel } from './Panel';

/** Simulator rate normal / peak (PUT /meters/simulator). */
export function SimulatorControl({ simulator, unavailable }: { simulator: SimulatorStatus | null | undefined; unavailable?: boolean }) {
  const t = useT().demo;
  const run = useRunAction();
  const set = (mode: Extract<SimulatorMode, 'normal' | 'peak'>) =>
    run(
      () => call('PUT', '/meters/simulator', { mode }),
      (r) => {
        const s = toSimulator(r);
        return t.simulator.done(t.simulator.modes[s?.mode ?? mode], decimal(s?.ratePerS ?? 0));
      },
    );

  return (
    <Panel id="simulator-title" title={t.simulator.title}>
      <p className="font-semibold tabular-nums">
        {simulator ? t.simulator.current(t.simulator.modes[simulator.mode], decimal(simulator.ratePerS)) : unavailable ? t.simulator.unavailable : '…'}
      </p>
      <div className="flex flex-wrap gap-3">
        <ConfirmAction
          variant="secondary"
          label={t.simulator.normal}
          title={t.simulator.confirmTitle(t.simulator.modes.normal)}
          body={t.simulator.confirmBody}
          onConfirm={() => set('normal')}
        />
        <ConfirmAction
          variant="secondary"
          label={t.simulator.peak}
          title={t.simulator.confirmTitle(t.simulator.modes.peak)}
          body={t.simulator.confirmBody}
          onConfirm={() => set('peak')}
        />
      </div>
    </Panel>
  );
}
