import { OctagonX, ShieldCheck } from 'lucide-react';
import { StatusChip } from '@/components/ui/status-chip';
import type { IntegrityState } from '@/lib/api/types';
import { useT } from '@/lib/i18n';

/**
 * FE-04 integrity states (components.md "Integrity badge"): Verificat (green, shield) · Verificat de server (green
 * outline: the server re-hashed the stored bytes, the browser did not) · Neverificat (neutral) · Fișier corupt
 * detectat (crimson, octagon). Always an icon and a word.
 */
export function IntegrityBadge({ state }: { state: IntegrityState }) {
  const t = useT();
  const label = t.files.integrity[state] ?? t.files.integrity.unverified;
  switch (state) {
    case 'verified':
      return <StatusChip tone="ok" label={label} icon={ShieldCheck} />;
    case 'server_verified':
      return (
        <span
          data-tone="ok-outline"
          className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-chip bg-surface pr-2.5 pl-2 text-[13px] font-bold text-ok-ink shadow-[inset_0_0_0_1.5px_var(--fg-ok)]"
        >
          <ShieldCheck aria-hidden="true" className="size-4" strokeWidth={2.25} />
          {label}
        </span>
      );
    case 'corrupt':
      return <StatusChip tone="crit" label={label} icon={OctagonX} />;
    default:
      return <StatusChip tone="neutral" label={label} />;
  }
}
