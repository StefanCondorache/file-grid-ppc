'use client';

import { Copy, Equal, EqualNot, Info, OctagonX, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { announce } from '@/lib/a11y/announcer';
import { cn } from '@/lib/cn';
import { useT } from '@/lib/i18n';

type Verdict = { tone: 'ok' | 'crit' | 'neutral'; text: string; Icon: LucideIcon };

const TONE: Record<Verdict['tone'], string> = {
  ok: 'text-ok-ink',
  crit: 'text-crit-ink',
  neutral: 'text-ink-2',
};

/** A SHA-256 in full, never translated, wrapping anywhere; the first and last 8 characters are the ones people compare. */
function HashCode({ value }: { value: string }) {
  const ends = value.length > 16;
  return (
    <code translate="no" title={value} className="min-w-0 font-mono text-[13px] leading-5 text-ink-2 [overflow-wrap:anywhere]">
      {ends ? (
        <>
          <strong className="font-bold text-ink">{value.slice(0, 8)}</strong>
          {value.slice(8, -8)}
          <strong className="font-bold text-ink">{value.slice(-8)}</strong>
        </>
      ) : (
        value
      )}
    </code>
  );
}

function HashLine({ label, value }: { label: string; value: string | null }) {
  const t = useT();
  const d = t.files.detail.integrity;
  const copy = () => {
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(() => announce(d.copied));
  };
  return (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-center gap-3 rounded-control bg-sunken py-1.5 pr-1.5 pl-3">
      <dt className="text-[13px] font-semibold text-ink-2">{label}</dt>
      <dd className="flex min-w-0 items-center justify-between gap-2">
        {value ? (
          <>
            <HashCode value={value} />
            <Button variant="quiet" size="sm" className="shrink-0" aria-label={d.copy(label)} title={d.copy(label)} onClick={copy}>
              <Copy aria-hidden="true" />
            </Button>
          </>
        ) : (
          <span className="py-1.5 text-ink-3">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{d.noClientValue}</span>
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * Client and server SHA-256 side by side (components.md "Hash pair", F4), with the verdict in words and an icon.
 * `client` is the hash the browser computed at upload, `server` the one the backend computed when it stored the file.
 * A match proves the stored file equals what was sent, unless the stored copy was later found `corrupt`: then the
 * upload-time match no longer speaks for the bytes in storage, and the verdict says so instead.
 */
export function HashPair({ client, server, corrupt = false }: { client: string | null; server: string; corrupt?: boolean }) {
  const t = useT();
  const d = t.files.detail.integrity;
  const same = client !== null && client.toLowerCase() === server.toLowerCase();
  const verdict: Verdict =
    client === null
      ? { tone: 'neutral', text: d.noClient, Icon: Info }
      : !same
        ? { tone: 'crit', text: d.mismatch, Icon: EqualNot }
        : corrupt
          ? { tone: 'crit', text: d.corrupt, Icon: OctagonX }
          : { tone: 'ok', text: d.match, Icon: Equal };
  const { Icon } = verdict;
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <HashLine label={d.client} value={client} />
        <HashLine label={d.server} value={server} />
      </dl>
      <p data-verdict={verdict.tone} className={cn('flex items-start gap-2 text-sm font-semibold', TONE[verdict.tone])}>
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
        {verdict.text}
      </p>
    </div>
  );
}
