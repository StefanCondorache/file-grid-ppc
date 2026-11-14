import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import type { Severity } from '@/lib/upload/contract';

const LEVEL: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const BARS = ['h-1.5', 'h-2.5', 'h-3.5', 'h-4.5'] as const;

/**
 * Fault severity as rising level bars plus the word, in ink: severity is a property of the fault, not a status, so
 * it never borrows the OK / În pericol / Încălcat colours (direction.md §3).
 */
export function SeverityLevel({ severity }: { severity: Severity | null | undefined }) {
  const t = useT();
  if (!severity || !(severity in LEVEL)) {
    return (
      <span className="text-ink-3">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t.files.severityUnknown}</span>
      </span>
    );
  }
  const level = LEVEL[severity];
  return (
    <span data-level={level} className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className="inline-flex h-4.5 items-end gap-0.5">
        {BARS.map((height, i) => (
          <span key={height} data-bar={i < level ? 'on' : 'off'} className={cn('w-1 rounded-xs', height, i < level ? 'bg-ink' : 'bg-(--fg-line-strong)')} />
        ))}
      </span>
      {t.files.severity[severity]}
    </span>
  );
}
