'use client';

import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { useAppStore } from '@/stores/app-store';

/** Live connection status in words (never colour alone). */
export function LiveStatusPill() {
  const t = useT();
  const live = useAppStore((s) => s.live);
  const paused = useAppStore((s) => s.livePaused);
  const text =
    live === 'open' ? t.live.open
      : live === 'connecting' ? t.live.connecting
        : live === 'offline' ? t.live.offline
          : live === 'polling' ? t.live.polling
            : t.live.reconnecting(live.reconnectingInS);
  const ok = live === 'open' || live === 'polling';
  return (
    <span
      role="status"
      data-pulse={live === 'open' && !paused ? '' : undefined}
      className="live-pill hidden h-8 items-center gap-2 rounded-pill px-3 text-[13px] font-semibold text-ink-2 md:inline-flex"
    >
      {/* The ring only pulses on a live stream, and stops with "Actualizări live" off (WCAG 2.2.2). */}
      <span
        aria-hidden="true"
        data-dot={ok ? '' : undefined}
        className={cn('size-2 rounded-full', ok ? 'bg-ok' : 'bg-warn', live === 'open' && !paused && 'pulse-ring')}
      />
      {text}
    </span>
  );
}
