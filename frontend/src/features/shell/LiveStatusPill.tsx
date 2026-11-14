'use client';

import { useT } from '@/lib/i18n';
import { useAppStore } from '@/stores/app-store';

/** Live connection status in words (never colour alone). */
export function LiveStatusPill() {
  const t = useT();
  const live = useAppStore((s) => s.live);
  const text =
    live === 'open' ? t.live.open
      : live === 'connecting' ? t.live.connecting
        : live === 'offline' ? t.live.offline
          : live === 'polling' ? t.live.polling
            : t.live.reconnecting(live.reconnectingInS);
  const ok = live === 'open' || live === 'polling';
  return (
    <span role="status" className="hidden items-center gap-1.5 text-[13px] font-semibold text-ink-2 md:inline-flex">
      <span aria-hidden="true" className={ok ? 'size-2 rounded-full bg-ok' : 'size-2 rounded-full bg-warn'} />
      {text}
    </span>
  );
}
