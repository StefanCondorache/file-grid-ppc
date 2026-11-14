'use client';

import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { AUDIT_ACTIONS, type AuditFilters as Filters } from './types';
import { filtersFromParams } from './url';

const field = 'flex min-w-0 flex-col gap-1.5 text-sm font-semibold';
const control = 'h-11 rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink';

/** Filter form; uncontrolled and keyed by the URL, so reload and back/forward restore it. */
export function AuditFilters({ value, onApply }: { value: Filters; onApply: (f: Filters) => void }) {
  const t = useT().audit;
  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    onApply(filtersFromParams(new URLSearchParams([...data.entries()].map(([k, v]) => [k, String(v)]))));
  };
  return (
    <form onSubmit={submit} key={JSON.stringify(value)} className="rounded-panel border border-border bg-surface-2 p-4">
      <fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <legend className="mb-2 text-base font-bold">{t.filters.legend}</legend>
        <div className={field}>
          <label htmlFor="audit-action">{t.filters.action}</label>
          <select id="audit-action" name="action" defaultValue={value.action ?? ''} className={control}>
            <option value="">{t.filters.anyAction}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t.action[a]}
              </option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label htmlFor="audit-actor">{t.filters.actor}</label>
          <input id="audit-actor" name="actor" defaultValue={value.actor ?? ''} placeholder={t.filters.actorHint} className={control} autoComplete="off" />
        </div>
        <div className={field}>
          <label htmlFor="audit-file">{t.filters.file}</label>
          <input id="audit-file" name="fileId" defaultValue={value.fileId ?? ''} className={control} autoComplete="off" />
        </div>
        <div className={field}>
          <label htmlFor="audit-from">{t.filters.from}</label>
          <input id="audit-from" name="from" type="date" defaultValue={value.from ?? ''} className={control} />
        </div>
        <div className={field}>
          <label htmlFor="audit-to">{t.filters.to}</label>
          <input id="audit-to" name="to" type="date" defaultValue={value.to ?? ''} className={control} />
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit">{t.filters.apply}</Button>
        <Button type="button" variant="secondary" onClick={() => onApply({})}>
          {t.filters.clear}
        </Button>
      </div>
    </form>
  );
}
