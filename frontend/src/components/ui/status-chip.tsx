import { Check, Info, Minus, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok text-(--fg-on-ok)',
  warn: 'chip-warn',
  crit: 'bg-crit text-(--fg-on-crit)',
  info: 'bg-info-tint text-info-ink',
  neutral: 'bg-(--fg-neutral-tint) text-(--fg-neutral-ink)',
};

const TONE_ICON: Record<Tone, LucideIcon> = { ok: Check, warn: TriangleAlert, crit: OctagonX, info: Info, neutral: Minus };

/** Status = 6 px chip + icon + word; never colour alone, never a pill (A11Y-6). */
export function StatusChip({ tone, label, icon, className }: { tone: Tone; label: string; icon?: LucideIcon; className?: string }) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <span
      data-tone={tone}
      className={cn('inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-chip pr-2.5 pl-2 text-[13px] font-bold', TONE_CLASS[tone], className)}
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={2.25} />
      {label}
    </span>
  );
}
