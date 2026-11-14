'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';

type WindowId = keyof ReturnType<typeof useT>['monitoring']['observability']['windows'];

/**
 * The time window of a metrics view, as a segmented control of native radios (arrow keys move, one tab stop): the
 * matrix offers 5 minute / 1 oră / 24 de ore, the bulkhead chart its own set. Controlled; the screen keeps the value in
 * the URL (`?window=`) so a view can be shared.
 */
export function WindowSelect<W extends WindowId>({
  value,
  windows,
  onChange,
  label,
}: {
  value: W;
  windows: readonly W[];
  onChange: (window: W) => void;
  label?: string;
}) {
  const t = useT().monitoring.observability;
  const name = useId();
  const legend = label ?? t.windowLabel;
  return (
    <fieldset className="flex items-center gap-2">
      <legend className="sr-only">{legend}</legend>
      <span aria-hidden="true" className="text-[13px] font-semibold text-ink-2">
        {legend}
      </span>
      <div className="inline-flex rounded-pill border border-input bg-surface p-0.5">
        {windows.map((w) => (
          <label
            key={w}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center rounded-pill px-3.5 text-sm font-semibold whitespace-nowrap text-ink-2',
              'transition-colors duration-(--fg-dur-fast) motion-reduce:transition-none hover:text-ink',
              'has-checked:bg-chrome has-checked:text-(--fg-on-chrome)',
              'has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--fg-focus-outer) has-focus-visible:outline-solid',
            )}
          >
            <input type="radio" name={name} value={w} checked={value === w} onChange={() => onChange(w)} className="sr-only" />
            {t.windows[w]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
