'use client';

import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/queries';
import { announce } from '@/lib/a11y/announcer';
import { can } from '@/lib/auth/capabilities';
import { useT } from '@/lib/i18n';
import { REVEAL_WARNING_SECONDS, useReveal } from './useReveal';

const MIN_REASON = 10;

/** The clear values for the auditor, with the countdown, "Prelungește" in the last 15 s and "Ascunde acum". */
function RevealedValues({ values, secondsLeft, onExtend, onHide, extending }: {
  values: { applicantName: string | null; cnp: string | null; address: string | null };
  secondsLeft: number;
  onExtend: () => void;
  onHide: () => void;
  extending: boolean;
}) {
  const t = useT();
  const r = t.files.reveal;
  const warn = secondsLeft <= REVEAL_WARNING_SECONDS;
  const rows: [string, string | null][] = [[r.name, values.applicantName], [r.cnp, values.cnp], [r.address, values.address]];
  return (
    <section aria-labelledby="reveal-values-h" className="flex flex-col gap-3 rounded-control border-[1.5px] border-warn bg-warn-tint p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="reveal-values-h" className="font-bold">
          {r.revealedTitle}
        </h3>
        <span className="text-sm text-ink-2 tabular-nums">{r.secondsLeft(String(secondsLeft))}</span>
      </div>
      <dl className="flex flex-col gap-1.5">
        {rows
          .filter((row): row is [string, string] => typeof row[1] === 'string' && row[1] !== '')
          .map(([term, value]) => (
            <div key={term} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 text-sm">
              <dt className="font-semibold text-ink-2">{term}</dt>
              <dd dir="auto" className="font-mono [overflow-wrap:anywhere] [unicode-bidi:isolate]">
                {value}
              </dd>
            </div>
          ))}
      </dl>
      {warn && (
        <p role="status" className="flex items-center gap-2 text-sm font-semibold text-warn-ink">
          <TriangleAlert aria-hidden="true" className="size-4" />
          {r.warning(String(secondsLeft))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {warn && (
          <Button size="sm" onClick={onExtend} disabled={extending}>
            {r.extend}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onHide}>
          <EyeOff aria-hidden="true" />
          {r.hide}
        </Button>
      </div>
    </section>
  );
}

/**
 * FE-13 reveal of personal data: auditor only (other roles see the button disabled with the reason why), a reason of
 * at least 10 characters that the backend audits, values shown for 60 s and then hidden. The values are never put in
 * the URL, the page title or any storage (useReveal).
 */
export function RevealDialog({ fileId }: { fileId: string }) {
  const t = useT();
  const r = t.files.reveal;
  const me = useMe().data;
  const allowed = can(me, 'reveal_pii');
  const { reveal, values, secondsLeft, extend, hide, pending } = useReveal(fileId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const whyId = useId();
  const reasonId = useId();
  const errorId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < MIN_REASON) {
      setError(r.reasonTooShort);
      return;
    }
    setError(null);
    try {
      await reveal(reason.trim());
      setOpen(false);
      setReason('');
      announce(r.audited);
    } catch {
      setError(r.failed);
    }
  };

  const onHide = () => {
    hide();
    announce(r.hidden);
  };

  if (!allowed) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span title={r.onlyAuditor}>
          <Button variant="secondary" size="sm" disabled aria-describedby={whyId}>
            <Eye aria-hidden="true" />
            {r.open}
          </Button>
        </span>
        <span id={whyId} className="text-[13px] text-ink-2">
          {r.onlyAuditor}
        </span>
      </div>
    );
  }

  if (values) {
    return <RevealedValues values={values} secondsLeft={secondsLeft} onExtend={() => void extend()} onHide={onHide} extending={pending} />;
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason('');
          setError(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="secondary" size="sm" className="self-start">
          <Eye aria-hidden="true" />
          {r.open}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim fixed inset-0 z-40 bg-(--fg-scrim)" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,500px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 pop glass-strong glass-edge rounded-card border p-6 shadow-e3">
          <Dialog.Title className="text-xl font-bold">{r.title}</Dialog.Title>
          <Dialog.Description className="text-sm text-ink-2">{r.body}</Dialog.Description>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5 text-sm">
              <label htmlFor={reasonId} className="font-semibold">
                {r.reasonLabel}
              </label>
              <textarea
                id={reasonId}
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="rounded-control border-[1.5px] border-input bg-surface px-3 py-2 text-[15px] text-ink"
              />
              <span className="text-[13px] text-ink-2">{r.reasonHint}</span>
              {error && (
                <span id={errorId} role="alert" className="font-semibold text-crit-ink">
                  {error}
                </span>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {r.cancel}
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending ? r.pending : r.submit}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
