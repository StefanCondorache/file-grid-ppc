'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import type { GuaranteeState } from '@/lib/monitoring/contract';
import { Acknowledgement } from './Acknowledgement';
import { useGuaranteeAnnouncements } from './announce';
import { useAlerts, useGuarantees } from './queries';
import { sentenceFor } from './sentences';

const TONE: Record<GuaranteeState, Tone> = { ok: 'ok', at_risk: 'warn', violated: 'crit' };

/**
 * The alert banner under the top bar, on every screen (FE-07): one row per guarantee that is not OK, with its state,
 * the guarantee and its cause in words, and who acknowledged the alert. The slot is always rendered and only its
 * `grid-template-rows` changes (0fr calm, 1fr open), so content below moves in one smooth step and never jumps.
 * It has no live role (A11Y-16): changes are spoken through the announcer, worded as the guarantee cards word them.
 */
export function AlertBanner() {
  const t = useT().monitoring;
  const guarantees = useGuarantees();
  const alerts = useAlerts();
  useGuaranteeAnnouncements(guarantees.data);

  const notOk = (guarantees.data ?? []).filter((g) => g.state !== 'ok');
  const open = notOk.length > 0;
  const tone: Tone = notOk.some((g) => g.state === 'violated') ? 'crit' : 'warn';
  const activeAlert = (category: string) => alerts.data?.find((a) => a.category === category && a.state !== 'resolved');

  return (
    <div
      data-alert-banner
      data-open={open}
      data-tone={open ? tone : undefined}
      className={cn(
        'grid transition-[grid-template-rows] duration-(--fg-dur-normal) ease-smooth motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {open && (
          <section
            aria-label={t.alerts.region}
            className={cn(
              'flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-8 py-3 text-ink',
              tone === 'crit' ? 'border-crit bg-crit-tint' : 'border-(--fg-warn-border) bg-warn-tint',
            )}
          >
            <ul className="flex min-w-0 flex-1 flex-col gap-2">
              {notOk.map((g) => {
                const name = t.categories[g.category];
                const alert = activeAlert(g.category);
                return (
                  <li key={g.category} data-category={g.category} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusChip tone={TONE[g.state]} label={t.states[g.state]} className="shrink-0" />
                    <p className="min-w-0 flex-1 text-[15px]">
                      <strong className="font-bold">{name}:</strong> {sentenceFor(g)}
                    </p>
                    {alert && <Acknowledgement alert={alert} guarantee={name} />}
                  </li>
                );
              })}
            </ul>
            <Link href="/" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0')}>
              {t.alerts.details}
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}
