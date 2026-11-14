import { decimal } from '@/features/guarantees/sentences';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import type { MeterCounters } from '@/lib/monitoring/contract';

/** Readings per zone: the number and rate as text, a decorative bar for the share. */
export function ZoneSplit({ byZone }: { byZone: MeterCounters['byZone'] }) {
  const t = useT();
  const total = byZone.reduce((n, z) => n + z.received, 0) || 1;
  return (
    <section aria-labelledby="zones-title" className="flex flex-col gap-3 rounded-card border border-border bg-card p-5 shadow-e1">
      <h3 id="zones-title" className="text-lg font-bold">
        {t.meters.zonesTitle}
      </h3>
      <dl className="flex flex-col gap-3">
        {byZone.map((z) => (
          <div key={z.zone} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-semibold">{t.live.zones[z.zone] ?? z.zone}</dt>
              <dd className="text-sm tabular-nums text-ink-2">{t.meters.zone(formatInt(z.received), decimal(z.ratePerS))}</dd>
            </div>
            <div aria-hidden="true" className="h-2 overflow-hidden rounded-pill bg-sunken">
              <div className="h-full bg-cat-meter" style={{ width: `${Math.round((z.received / total) * 100)}%` }} />
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
