import { decimal } from '@/features/guarantees/sentences';
import { useT } from '@/lib/i18n';
import type { SimulatorStatus } from '@/lib/monitoring/contract';

/** Readings stored per second now, with the simulator's mode. Not a live region (A11Y-17). */
export function RateKpi({ ratePerS, simulator }: { ratePerS: number | null; simulator: SimulatorStatus | null | undefined }) {
  const t = useT();
  return (
    <div className="lift flex flex-col gap-1 rounded-card border border-border bg-card p-5 shadow-e1">
      <span className="text-sm text-ink-2">{t.meters.rate}</span>
      <span className="text-[40px] leading-tight font-bold tracking-tight tabular-nums">
        {ratePerS === null ? '—' : decimal(ratePerS)} <span className="text-lg font-semibold text-ink-2">{t.meters.rateUnit}</span>
      </span>
      {simulator && (
        <span className="text-sm text-ink-2">
          {t.meters.simulatorMode(t.demo.simulator.modes[simulator.mode])}
          {simulator.queueDepth > 0 && ` · ${t.meters.queue(decimal(simulator.queueDepth))}`}
        </span>
      )}
    </div>
  );
}
