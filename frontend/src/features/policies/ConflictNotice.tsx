'use client';

import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { diffPolicy } from './diff';
import type { PolicyDoc } from './types';

/** 409: what the other person changed (my base → server), with re-apply or discard. */
export function ConflictNotice({ base, current, onApply, onDiscard }: { base: PolicyDoc; current: PolicyDoc; onApply: () => void; onDiscard: () => void }) {
  const t = useT().policies;
  const rows = diffPolicy(base, current);
  return (
    <section role="alert" className="flex flex-col gap-3 rounded-panel border border-warn bg-warn-tint p-5 text-ink">
      <h2 className="text-lg font-bold text-warn-ink">{t.conflict.title(current.version)}</h2>
      <p>{t.conflict.body}</p>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t.conflict.title(current.version)}</caption>
        <thead>
          <tr className="border-b border-ink-3">
            <th scope="col" className="py-2 pr-3">{t.diff.field}</th>
            <th scope="col" className="py-2 pr-3">{t.diff.from}</th>
            <th scope="col" className="py-2">{t.diff.to}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field}>
              <th scope="row" className="py-2 pr-3">{r.field}</th>
              <td className="py-2 pr-3">{r.from}</td>
              <td className="py-2 font-semibold">{r.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap gap-3">
        <Button onClick={onApply}>{t.conflict.apply(current.version)}</Button>
        <Button variant="secondary" onClick={onDiscard}>{t.conflict.discard}</Button>
      </div>
    </section>
  );
}
