import { Card } from '@/components/ui/card';
import { decimal } from '@/features/guarantees/sentences';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import type { MeterCounters } from '@/lib/monitoring/contract';

/** Readings per zone: the number and rate as text, a decorative bar for the share. */
export function ZoneSplit({ byZone }: { byZone: MeterCounters['byZone'] }) {
  const t = useT();
  const total = byZone.reduce((n, z) => n + z.received, 0) || 1;
  return (
    <Card aria-labelledby="zones-title" className="flex flex-col gap-3 p-5">
      <h3 id="zones-title" className="text-lg font-bold">
        {t.meters.zonesTitle}
      </h3>
      {/* dt and dd sit directly in each group div (a valid dl); the bar is a second, hidden dd. */}
      <dl className="flex flex-col gap-3">
        {byZone.map((z) => (
          <div key={z.zone} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1">
            <dt className="font-semibold">{t.live.zones[z.zone] ?? z.zone}</dt>
            <dd className="text-sm tabular-nums text-ink-2">{t.meters.zone(formatInt(z.received), decimal(z.ratePerS))}</dd>
            <dd aria-hidden="true" className="col-span-2 h-2 overflow-hidden rounded-pill bg-sunken">
              <div className="h-full bg-cat-meter" style={{ width: `${Math.round((z.received / total) * 100)}%` }} />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
