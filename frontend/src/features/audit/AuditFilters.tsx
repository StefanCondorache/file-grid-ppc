'use client';

import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

export type AuditFilterValues = { action: string; actor: string; fileId: string; from: string; to: string };

const input = 'h-10 rounded-control border border-input bg-surface px-3 text-ink';

export function AuditFilters({ values, onChange }: { values: AuditFilterValues; onChange: (patch: Partial<AuditFilterValues>) => void }) {
  const t = useT();
  const f = t.audit.filters;
  const field = (key: keyof AuditFilterValues, label: string, type = 'text') => (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      {label}
      <input className={input} type={type} value={values[key]} onChange={(e) => onChange({ [key]: e.target.value })} />
    </label>
  );
  const dirty = Object.values(values).some(Boolean);
  return (
    <form role="search" aria-label={f.label} className="flex flex-wrap items-end gap-3 rounded-card glass-card p-5" onSubmit={(e) => e.preventDefault()}>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        {f.action}
        <select className={input} value={values.action} onChange={(e) => onChange({ action: e.target.value })}>
          <option value="">{f.anyAction}</option>
          {Object.entries(t.audit.actions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {field('actor', f.actor)}
      {field('fileId', f.fileId)}
      {field('from', f.from, 'date')}
      {field('to', f.to, 'date')}
      {dirty && <Button type="button" variant="quiet" onClick={() => onChange({ action: '', actor: '', fileId: '', from: '', to: '' })}>{f.reset}</Button>}
    </form>
  );
}
