'use client';

import { AlertDialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

export type DiffRow = { field: string; from: string; to: string };

export function DiffDialog({ open, rows, saving, onConfirm, onCancel }: { open: boolean; rows: DiffRow[]; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  const t = useT().policies;
  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="scrim fixed inset-0 z-40 bg-(--fg-scrim)" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 pop glass-strong glass-edge rounded-card border p-6 shadow-e3">
          <AlertDialog.Title className="text-xl font-bold">{t.confirmTitle}</AlertDialog.Title>
          <AlertDialog.Description className="text-ink-2">{t.inFlightNote}</AlertDialog.Description>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.field} className="rounded-panel border border-border bg-surface-2 p-3 text-sm">
                <strong>{r.field}</strong>: {r.from} → <strong>{r.to}</strong>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={onCancel} disabled={saving}>{t.cancel}</Button>
            <Button onClick={onConfirm} disabled={saving}>{t.save}</Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
