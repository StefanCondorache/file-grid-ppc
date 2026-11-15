'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

export type AuditFilterValues = { action: string; actor: string; fileId: string; from: string; to: string };

const input = 'h-10 rounded-control border border-input bg-surface px-3 text-ink';
const TEXT_KEYS = ['actor', 'fileId'] as const;

/**
 * The action and the dates apply on change; the text fields apply on submit (Enter or the button),
 * like the files search: bound to the URL on every keystroke, a fast typist lost characters while
 * the URL caught up.
 */
export function AuditFilters({ values, onChange }: { values: AuditFilterValues; onChange: (patch: Partial<AuditFilterValues>) => void }) {
  const t = useT();
  const f = t.audit.filters;
  // Remounts the text fields after "Șterge filtrele", so they show the cleared values.
  const [cleared, setCleared] = useState(0);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onChange(Object.fromEntries(TEXT_KEYS.map((k) => [k, String(data.get(k) ?? '').trim()])));
  };
  const text = (key: (typeof TEXT_KEYS)[number], label: string) => (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      {label}
      <input key={cleared} className={input} type="text" name={key} defaultValue={values[key]} />
    </label>
  );
  const date = (key: 'from' | 'to', label: string) => (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      {label}
      <input className={input} type="date" value={values[key]} onChange={(e) => onChange({ [key]: e.target.value })} />
    </label>
  );
  const dirty = Object.values(values).some(Boolean);
  return (
    <form role="search" aria-label={f.label} className="flex flex-wrap items-end gap-3 rounded-card glass-card p-5" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        {f.action}
        <select className={input} value={values.action} onChange={(e) => onChange({ action: e.target.value })}>
          <option value="">{f.anyAction}</option>
          {Object.entries(t.audit.actions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {text('actor', f.actor)}
      {text('fileId', f.fileId)}
      {date('from', f.from)}
      {date('to', f.to)}
      <Button type="submit" variant="secondary">{f.apply}</Button>
      {dirty && (
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            setCleared((n) => n + 1);
            onChange({ action: '', actor: '', fileId: '', from: '', to: '' });
          }}
        >
          {f.reset}
        </Button>
      )}
    </form>
  );
}
