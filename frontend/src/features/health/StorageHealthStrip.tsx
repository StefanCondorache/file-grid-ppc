'use client';

import { Check, Clock, Minus, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { Tooltip } from 'radix-ui';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Tone } from '@/components/ui/status-chip';
import { useMe } from '@/features/auth/queries';
import { announce } from '@/lib/a11y/announcer';
import { can } from '@/lib/auth/capabilities';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { formatDuration } from '@/lib/i18n/format';
import type { StorageHealth, StorageId, StorageStatus } from '@/lib/monitoring/contract';
import { STRIP_ORDER, useStorageHealth } from './queries';

/** A chip's state: the server's status, or ours while it has not answered (`pending`) or did not report it. */
type ChipState = StorageStatus | 'pending' | 'unknown';

const TONE: Record<ChipState, Tone> = { ok: 'ok', degraded: 'warn', down: 'crit', pending: 'neutral', unknown: 'neutral' };
const ICON: Record<ChipState, LucideIcon> = { ok: Check, degraded: TriangleAlert, down: OctagonX, pending: Clock, unknown: Minus };

/** OK chips stay quiet (outlined) so a red or yellow one stands out; status is still icon + word, 6 px radius. */
const CHIP: Record<ChipState, string> = {
  ok: 'border border-border bg-surface text-ink',
  degraded: 'bg-warn text-(--fg-on-warn) shadow-[inset_0_0_0_1.5px_var(--fg-warn-border)]',
  down: 'bg-crit text-(--fg-on-crit)',
  pending: 'bg-(--fg-neutral-tint) text-(--fg-neutral-ink)',
  unknown: 'bg-(--fg-neutral-tint) text-(--fg-neutral-ink)',
};

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Speaks a storage's status change (accessibility.md §4): down assertive; degraded and recovery polite; silent on load. */
function useHealthAnnouncements(items: StorageHealth[] | undefined) {
  const t = useT().monitoring.health;
  const last = useRef(new Map<StorageId, StorageStatus>());
  useEffect(() => {
    if (!items) return;
    for (const { storage, status } of items) {
      const before = last.current.get(storage);
      last.current.set(storage, status);
      if (before === undefined || before === status) continue;
      const name = t.storages[storage];
      if (status === 'ok') announce(t.recovered(name), 'polite');
      else announce(t.changed(name, t.states[status]), status === 'down' ? 'assertive' : 'polite');
    }
  }, [items, t]);
}

/**
 * The storage health strip in the top bar, on every screen (FE-08): Postgres · S3 · FTP, each a status chip with
 * icon, word and probe latency (from 1440 px; narrower top bars keep it in the tooltip), and the last check on hover
 * or focus. It links to Observabilitate for the roles that can open it. The statuses come from the backend's health
 * monitor; the strip never decides one.
 */
export function StorageHealthStrip() {
  const t = useT().monitoring.health;
  const health = useStorageHealth();
  const me = useMe();
  const linked = can(me.data, 'view_observability');
  useHealthAnnouncements(health.data);

  return (
    <Tooltip.Provider delayDuration={300}>
      <ul aria-label={t.label} className="flex items-center gap-1.5">
        {STRIP_ORDER.map((storage) => {
          const h = health.data?.find((x) => x.storage === storage);
          const state: ChipState = h?.status ?? (health.data || health.isError ? 'unknown' : 'pending');
          const Icon = ICON[state];
          const chipClass = cn(
            'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-chip px-2 text-[13px] font-semibold xl:px-2.5',
            CHIP[state],
            linked && 'underline-offset-2 hover:underline',
          );
          const content: ReactNode = (
            <>
              <Icon aria-hidden="true" className={cn('size-4 shrink-0', state === 'ok' && 'text-ok')} strokeWidth={2.25} />
              <span data-storage-name className="font-bold">
                {t.storages[storage]}
              </span>{' '}
              {/* Narrow top bars keep the check glyph for OK and say the word to screen readers only; problems always show it. */}
              <span className={cn(state === 'ok' && 'max-xl:sr-only')}>{t.states[state]}</span>
              {h && h.status !== 'down' && h.latencyMs !== null && (
                <>
                  {' '}
                  <span className={cn('hidden font-normal min-[1440px]:inline', state === 'ok' && 'text-ink-2')}>{formatDuration(h.latencyMs)}</span>
                </>
              )}
            </>
          );
          const chip = linked ? (
            <Link href="/observability" data-tone={TONE[state]} className={chipClass}>
              {content}
            </Link>
          ) : (
            <span data-tone={TONE[state]} className={chipClass}>
              {content}
            </span>
          );
          const checked = h?.lastCheckAt ? new Date(h.lastCheckAt) : null;
          const details = [
            checked && !Number.isNaN(checked.getTime()) ? t.lastCheck(clock.format(checked)) : null,
            h && h.latencyMs !== null ? formatDuration(h.latencyMs) : null,
            h ? t.circuit[h.circuitState] : null,
          ].filter(Boolean);
          return (
            <li key={storage} data-status={state} className="flex">
              {details.length > 0 ? (
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>{chip}</Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content sideOffset={6} className="z-50 rounded-control bg-sidebar px-2.5 py-1.5 text-xs font-semibold text-sidebar-foreground shadow-e2">
                      {details.join(' · ')}
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              ) : (
                chip
              )}
            </li>
          );
        })}
      </ul>
    </Tooltip.Provider>
  );
}
