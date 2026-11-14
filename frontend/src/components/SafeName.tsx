import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';
import { cleanName } from './clean-name';

/** Renders an untrusted file name as inert, direction-isolated text (SR-7). */
export function SafeName({ name, className }: { name: string; className?: string }) {
  const t = useT();
  const { text, mixedScripts } = cleanName(name);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <span dir="auto" title={text} className="truncate [unicode-bidi:isolate]">
        {text}
      </span>
      {mixedScripts && (
        <span className="shrink-0 rounded-chip bg-warn-tint px-1.5 text-xs font-semibold text-warn-ink">
          {t.common.unusualChars}
        </span>
      )}
    </span>
  );
}
