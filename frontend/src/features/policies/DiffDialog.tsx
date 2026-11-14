'use client';

import { Dialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import type { DiffRow } from './diff';

export function DiffTable({ rows, caption }: { rows: DiffRow[]; caption: string }) {
  const t = useT().policies.diff;
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border text-ink-2">
          <th scope="col" className="py-2 pr-3 font-semibold">{t.field}</th>
          <th scope="col" className="py-2 pr-3 font-semibold">{t.from}</th>
          <th scope="col" className="py-2 font-semibold">{t.to}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.field} className="border-b border-border last:border-0">
            <th scope="row" className="py-2 pr-3 font-semibold">{r.field}</th>
            <td className="py-2 pr-3 text-ink-2 line-through">{r.from}</td>
            <td className="py-2 font-semibold">{r.to}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Props = { open: boolean; category: string; baseVersion: number; rows: DiffRow[]; saving: boolean; onCancel: () => void; onConfirm: () => void };

/** Confirmation step before PUT: what changes, from which version to which. */
export function DiffDialog({ open, category, baseVersion, rows, saving, onCancel, onConfirm }: Props) {
  const t = useT().policies.diff;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !saving && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--fg-scrim)" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card bg-card p-6 text-card-foreground shadow-e3">
          <Dialog.Title className="text-xl font-bold">{t.title}</Dialog.Title>
          <Dialog.Description className="text-ink-2">{t.description(category, baseVersion)}</Dialog.Description>
          <DiffTable rows={rows} caption={t.title} />
          <div className="flex flex-wrap justify-end gap-3">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={saving}>{t.cancel}</Button>
            </Dialog.Close>
            <Button onClick={onConfirm} disabled={saving}>{saving ? t.saving : t.confirm}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
