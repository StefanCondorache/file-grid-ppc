'use client';

import { AlertDialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Mounted only while the dialog is open, so its clock starts at the moment it opens. */
function Countdown({ deadline }: { deadline: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{t.session.warnBody(mmss(deadline - now))}</>;
}

/** T−2 min warning with a one-action extend (A11Y-18, WCAG 2.2.1). Focus starts on "Rămân conectat". */
export function SessionExpiryDialog({ open, deadline, onStay, onLogout }: { open: boolean; deadline: number; onStay: () => void; onLogout: () => void }) {
  const t = useT();
  const stayRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="scrim fixed inset-0 z-40 bg-(--fg-scrim)" />
        <AlertDialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            stayRef.current?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 pop glass-strong rounded-card border p-6 shadow-e3"
        >
          <AlertDialog.Title className="text-xl font-bold">{t.session.warnTitle}</AlertDialog.Title>
          <AlertDialog.Description className="text-ink-2">
            <Countdown deadline={deadline} />
          </AlertDialog.Description>
          <div className="flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" onClick={onLogout}>{t.session.logout}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button ref={stayRef} onClick={onStay}>{t.session.stay}</Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
