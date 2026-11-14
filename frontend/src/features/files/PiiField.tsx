import { EyeOff } from 'lucide-react';
import { useT } from '@/lib/i18n';

/**
 * A personal value as the backend masks it ("I*** P***", "2*********123"), never the clear value (ADR-0013, A11Y-21).
 * The mask is drawn for sighted users and hidden from the accessibility tree; screen readers hear "Nume mascat" or
 * "CNP mascat, ultimele trei cifre 123" instead of a row of stars. Neither the mask nor any clear value is put in an
 * attribute. A value that carries no mask character is a backend slip, so it is not shown at all.
 */
export function PiiField({ kind, masked }: { kind: 'name' | 'cnp'; masked: string | null | undefined }) {
  const t = useT();
  const p = t.files.detail.pii;
  const value = typeof masked === 'string' && masked.includes('*') ? masked : null;
  if (!value) {
    return (
      <span className="text-ink-3">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{kind === 'name' ? p.nameUnavailable : p.cnpUnavailable}</span>
      </span>
    );
  }
  const lastDigits = kind === 'cnp' ? /(\d{3})$/.exec(value)?.[1] : undefined;
  const spoken = kind === 'name' ? p.nameMasked : lastDigits ? p.cnpMaskedLast(lastDigits) : p.cnpMasked;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span aria-hidden="true" dir="auto" className="font-mono tracking-wide [unicode-bidi:isolate]">
        {value}
      </span>
      <span aria-hidden="true" className="inline-flex h-[22px] items-center gap-1 rounded-chip bg-sunken px-1.5 text-xs font-semibold text-ink-2">
        <EyeOff className="size-3.5" />
        {p.masked}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
