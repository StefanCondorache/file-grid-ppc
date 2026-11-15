'use client';

import { AlertDialog } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

type Variant = 'primary' | 'secondary' | 'danger';

/**
 * A demo action behind an in-page confirmation (never window.confirm): the trigger opens an AlertDialog whose focus
 * starts on "Anulează"; confirming runs the action and keeps the trigger busy until it settles.
 */
export function ConfirmAction({
  label,
  title,
  body,
  variant,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  body: ReactNode;
  variant: Variant;
  disabled?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const t = useT().demo;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    setOpen(false);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <Button variant={variant} size="lg" disabled={disabled || busy} aria-busy={busy}>
          {busy ? t.running : label}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="scrim fixed inset-0 z-40 bg-(--fg-scrim)" />
        <AlertDialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 pop glass-strong glass-edge rounded-card border p-6 shadow-e3"
        >
          <AlertDialog.Title className="text-xl font-bold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-ink-2">{body}</AlertDialog.Description>
          <div className="flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button ref={cancelRef} variant="secondary">
                {t.cancel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={variant} onClick={() => void confirm()}>
                {label}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
