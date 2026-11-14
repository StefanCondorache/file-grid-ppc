'use client';

import { Pause, Play } from 'lucide-react';
import { announce } from '@/lib/a11y/announcer';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { useAppStore } from '@/stores/app-store';

/**
 * "Actualizări live" (A11Y-14, WCAG 2.2.2): pauses every live update and motion. The bridge buffers stream events and
 * polled views stop refetching; resuming applies the latest snapshot. The new state is announced.
 */
export function LivePauseSwitch() {
  const t = useT().monitoring.livePause;
  const paused = useAppStore((s) => s.livePaused);
  const setPaused = useAppStore((s) => s.setLivePaused);

  const toggle = () => {
    const next = !paused;
    setPaused(next);
    announce(next ? t.announceOff : t.announceOn, 'polite');
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={!paused}
      onClick={toggle}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-pill border-[1.5px] px-3 text-sm font-semibold whitespace-nowrap transition-colors duration-(--fg-dur-fast)',
        paused ? 'border-(--fg-warn-border) bg-warn-tint text-warn-ink' : 'border-border bg-surface text-ink hover:bg-surface-2',
      )}
    >
      {paused ? <Play aria-hidden="true" className="size-4" /> : <Pause aria-hidden="true" className="size-4" />}
      <span className="sr-only xl:not-sr-only">{t.label}</span>
      <span className="sr-only">: {paused ? t.off : t.on}</span>
    </button>
  );
}
