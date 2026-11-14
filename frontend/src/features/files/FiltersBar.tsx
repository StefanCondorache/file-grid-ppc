'use client';

import { RotateCcw, Search } from 'lucide-react';
import { useId, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ROLE_OPTIONS } from '@/features/auth/roles';
import { cn } from '@/lib/cn';
import { plural, useT } from '@/lib/i18n';
import {
  activeFilterCount, INTEGRITY_STATES, ORIGINS, READING_ORIGINS, STORAGES, ZONES, type FileCategoryId, type FileFilters,
} from './filters';

const CONTROL = 'h-10 w-full rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] text-ink';

const CATEGORY_DOT: Record<FileCategoryId, string> = {
  fault_records: 'bg-cat-fault',
  drone_videos: 'bg-cat-drone',
  connection_documents: 'bg-cat-connection',
  meter_readings: 'bg-cat-meter',
};

function Field({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}

function Choice<T extends string>({ label, value, options, anyLabel, onChange }: { label: string; value: T | undefined; options: readonly { value: T; label: string }[]; anyLabel: string; onChange(v: T | undefined): void }) {
  const id = useId();
  return (
    <Field id={id} label={label}>
      <select id={id} className={CONTROL} value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Day({ label, value, min, max, onChange }: { label: string; value: string | undefined; min?: string; max?: string; onChange(v: string | undefined): void }) {
  const id = useId();
  return (
    <Field id={id} label={label}>
      <input id={id} type="date" className={cn(CONTROL, 'tabular-nums')} value={value ?? ''} min={min} max={max} onChange={(e) => onChange(e.target.value || undefined)} />
    </Field>
  );
}

/**
 * Filters of the files list (components.md "Filters bar"): category pills, search, zone, interval, uploader,
 * integrity, storage, origin and "Ascunde datele generate". It holds no state: every change goes to the URL
 * through `onChange`, and the values come back from it.
 */
export function FiltersBar({ filters, categories, onChange, onReset }: { filters: FileFilters; categories: readonly FileCategoryId[]; onChange(patch: Partial<FileFilters>): void; onReset(): void }) {
  const t = useT();
  const f = t.files.filters;
  const searchId = useId();
  const hintId = useId();
  const switchId = useId();
  const count = activeFilterCount(filters);
  const generatedHidden = filters.excludeGenerated === true;
  // Readings (6c.4) are found by meter id, zone and origin only; the other filters do not apply to them.
  const meterView = filters.category === 'meter_readings';
  const search = meterView
    ? { label: t.files.meter.search, placeholder: t.files.meter.searchPlaceholder, hint: t.files.meter.searchHint, maxLength: 64 }
    : { label: f.search, placeholder: f.searchPlaceholder, hint: f.searchHint, maxLength: 100 };

  const submitSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (q !== (filters.q ?? '')) onChange({ q: q || undefined });
  };

  const pill = (pressed: boolean) =>
    cn(
      'inline-flex h-9 items-center gap-2 rounded-pill border-[1.5px] px-4 text-sm font-semibold transition-colors duration-(--fg-dur-fast)',
      pressed ? 'border-ink bg-ink text-surface' : 'border-input bg-surface text-ink hover:bg-surface-2',
    );

  return (
    <form role="search" aria-label={f.label} onSubmit={submitSearch} className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-e1">
      <div role="group" aria-label={f.category} className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={!filters.category} className={pill(!filters.category)} onClick={() => onChange({ category: undefined })}>
          {f.all}
        </button>
        {categories.map((c) => (
          <button key={c} type="button" aria-pressed={filters.category === c} className={pill(filters.category === c)} onClick={() => onChange({ category: c })}>
            <span aria-hidden="true" className={cn('size-2.5 rounded-full', CATEGORY_DOT[c])} />
            {t.files.categories[c]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
        <Field id={searchId} label={search.label} className="col-span-2">
          <div className="flex gap-2">
            <input
              key={filters.q ?? ''}
              id={searchId}
              name="q"
              type="search"
              defaultValue={filters.q}
              maxLength={search.maxLength}
              placeholder={search.placeholder}
              aria-describedby={hintId}
              autoComplete="off"
              className={CONTROL}
            />
            <Button type="submit" variant="secondary" size="md" aria-label={f.search} title={f.search} className="shrink-0 px-3">
              <Search aria-hidden="true" />
            </Button>
          </div>
          <span id={hintId} className="text-[13px] text-ink-3">
            {search.hint}
          </span>
        </Field>
        <Choice label={f.zone} anyLabel={f.allZones} value={filters.zone} options={ZONES.map((z) => ({ value: z, label: t.files.zones[z] }))} onChange={(zone) => onChange({ zone })} />
        {!meterView && (
          <>
            <Day label={f.from} value={filters.from} max={filters.to} onChange={(from) => onChange({ from })} />
            <Day label={f.to} value={filters.to} min={filters.from} onChange={(to) => onChange({ to })} />
            <Choice label={f.uploader} anyLabel={f.anyone} value={filters.uploader} options={ROLE_OPTIONS.map((r) => ({ value: r.role, label: r.label }))} onChange={(uploader) => onChange({ uploader })} />
            <Choice label={f.integrity} anyLabel={f.any} value={filters.integrity} options={INTEGRITY_STATES.map((s) => ({ value: s, label: t.files.integrity[s] }))} onChange={(integrity) => onChange({ integrity })} />
            <Choice label={f.storage} anyLabel={f.any} value={filters.storage} options={STORAGES.map((s) => ({ value: s, label: t.files.storage[s] }))} onChange={(storage) => onChange({ storage })} />
          </>
        )}
        <Choice
          label={f.origin}
          anyLabel={f.any}
          value={filters.origin}
          options={(meterView ? READING_ORIGINS : ORIGINS).map((o) => ({ value: o, label: t.files.origin[o] }))}
          onChange={(origin) => onChange({ origin })}
        />
      </div>

      {(!meterView || count > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Every reading is generated by the meters: hiding generated data would leave the readings view empty. */}
          {!meterView && (
            <div className="flex items-center gap-3">
              {/* The markup Radix Switch renders, without its form-size observer (no ResizeObserver needed). */}
              <button
                id={switchId}
                type="button"
                role="switch"
                aria-checked={generatedHidden}
                onClick={() => onChange({ excludeGenerated: generatedHidden ? undefined : true })}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill transition-colors duration-(--fg-dur-fast)',
                  generatedHidden ? 'bg-ink' : 'bg-(--fg-line-strong)',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('block size-5 rounded-full bg-surface shadow-e1 transition-transform duration-(--fg-dur-fast)', generatedHidden ? 'translate-x-[22px]' : 'translate-x-0.5')}
                />
              </button>
              <label htmlFor={switchId} className="text-sm font-semibold">
                {f.excludeGenerated}
              </label>
            </div>
          )}
          {count > 0 && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-sm text-ink-2 tabular-nums">{plural(count, f.applied)}</span>
              <Button type="button" variant="quiet" size="sm" onClick={onReset}>
                <RotateCcw aria-hidden="true" />
                {f.reset}
              </Button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
