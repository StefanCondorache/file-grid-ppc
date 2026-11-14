'use client';

import Link from 'next/link';
import { Clock, CloudOff, FileSearch, Pause, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { useEffect, useId, useRef, useState } from 'react';
import { SafeName } from '@/components/SafeName';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { Tag } from '@/components/ui/tag';
import { useT } from '@/lib/i18n';
import { formatBytes, formatDuration, formatPercent } from '@/lib/i18n/format';
import { cn } from '@/lib/cn';
import { RESUMABLE, RUNNING, uploadEngine } from '@/lib/upload/engine';
import { formatLimit } from '@/lib/upload/plan';
import { useUploadStore, type UploadItemView } from '@/lib/upload/store';
import type { UploadCategoryId, UploadState } from '@/lib/upload/types';
import { ChunkGrid, ChunkLegend, confirmedCount, confirmedPercent } from './ChunkGrid';

const NBSP = '\u00A0';

const TONE: Record<UploadState, Tone> = {
  queued: 'neutral',
  hashing: 'info',
  uploading: 'info',
  paused: 'neutral',
  connection_lost: 'warn',
  verifying: 'info',
  verified: 'ok',
  failed: 'crit',
  needs_file: 'warn',
};

const CATEGORY_DOT: Record<UploadCategoryId, string> = {
  drone_videos: 'bg-cat-drone',
  fault_records: 'bg-cat-fault',
  connection_documents: 'bg-cat-connection',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** First and last 8 hex characters: enough to compare two hashes by eye; the full value is in `title`. */
export const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

/** "45 s", "3 min", "1 h 05 min". */
function shortDuration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))}${NBSP}s`;
  if (s < 3600) return `${Math.round(s / 60)}${NBSP}min`;
  const h = Math.floor(s / 3600);
  return `${h}${NBSP}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}${NBSP}min`;
}

/** Seconds to the next automatic retry; ticks every second while the row waits (the engine does not tick it). */
function useRetryIn(item: UploadItemView): number | undefined {
  const waiting = item.state === 'connection_lost' && item.retryAt !== undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  if (!waiting || item.retryAt === undefined) return undefined;
  // `retryInS` was taken with the snapshot, so it bounds a clock that has not ticked since.
  return Math.max(0, Math.min(item.retryInS ?? Number.POSITIVE_INFINITY, Math.ceil((item.retryAt - now) / 1000)));
}

/**
 * Coada de încărcare (SC-03): every upload of the signed-in user, read from the engine's store. Each row shows its
 * state as words and a chip, its chunk grid, who started it and under which policy, and the actions that fit its
 * state. Rows are never re-ordered.
 */
export function UploadQueue() {
  const t = useT().upload;
  const titleId = useId();
  const items = Object.values(useUploadStore((s) => s.items));
  const active = items.filter((i) => RUNNING.includes(i.state)).length;
  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={titleId} className="text-lg font-bold">
          {t.queue.title}
        </h2>
        {items.length > 0 && <span className="text-sm text-ink-2">{t.queue.summary(items.length, active)}</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-ink-2">{t.queue.empty}</p>
      ) : (
        <>
          {items.some((i) => i.partCount) && <ChunkLegend />}
          <ul data-queue="" className="flex flex-col gap-3">
            {items.map((item) => (
              <QueueRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function QueueRow({ item }: { item: UploadItemView }) {
  const t = useT();
  const u = t.upload;
  const nameId = useId();
  const retryIn = useRetryIn(item);
  const parts = item.partCount ?? 0;
  const done = parts > 0 ? confirmedCount(parts, item.confirmed) : 0;
  const percent = item.state === 'verified' ? 100 : confirmedPercent(parts, done);
  const hashedPercent = item.size > 0 ? Math.min(99, Math.floor((item.hashedBytes / item.size) * 100)) : 0;

  let chip = capitalize(u.stateLabel[item.state]);
  let spoken: string | undefined = u.stateLabel[item.state];
  if (item.state === 'hashing') chip = `${chip} · ${formatPercent(hashedPercent / 100, 0)}`;
  if (item.state === 'paused' && item.pausedReason) chip = `${chip} · ${u.queue.pausedFor[item.pausedReason]}`;
  if (item.state === 'connection_lost') spoken = item.offline ? u.queue.offlineSpoken : retryIn !== undefined ? u.queue.retrySpoken(retryIn) : spoken;
  if (item.state === 'uploading') spoken = item.etaS !== null ? u.queue.left(shortDuration(item.etaS)) : undefined;
  if (item.state === 'verified') spoken = undefined;

  const lost = item.state === 'connection_lost';
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-panel border border-border bg-surface p-4',
        lost && 'border-(--fg-warn-border) shadow-[inset_4px_0_0_var(--fg-warn)]',
        item.state === 'failed' && 'border-crit',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', CATEGORY_DOT[item.category])} />
          <span id={nameId} className="min-w-0 text-base font-bold">
            <SafeName name={item.displayName} className="max-w-full" />
          </span>
          <span className="shrink-0 text-sm text-ink-2">{formatLimit(item.size)}</span>
        </div>
        <StatusChip
          tone={TONE[item.state]}
          icon={lost ? (item.offline ? CloudOff : Clock) : undefined}
          label={chip}
        />
      </div>
      {lost && (
        <p className="-mt-1 text-sm text-ink-2" aria-hidden="true">
          {item.offline ? u.queue.offlineWait : retryIn !== undefined ? u.queue.retryIn(retryIn) : null}
        </p>
      )}

      {item.state === 'hashing' ? (
        <>
          <div role="progressbar" aria-labelledby={nameId} aria-valuetext={u.queue.hashingValue} className="h-2 overflow-hidden rounded-full bg-(--fg-chunk-pending)">
            <span className="block h-full rounded-full bg-(--fg-chunk-flight)" style={{ width: `${hashedPercent}%` }} />
          </div>
          <p className="text-sm text-ink-2">{u.queue.hashingNote}</p>
        </>
      ) : (
        item.partCount !== null &&
        item.state !== 'verified' && (
          <ChunkGrid
            parts={item.partCount}
            confirmed={item.confirmed}
            inFlight={item.inFlightParts}
            failed={item.retryingParts}
            bytes={item.bytesConfirmed}
            size={item.size}
            labelledBy={nameId}
            detail={spoken}
          />
        )
      )}

      {item.partCount !== null && item.state !== 'verified' && item.state !== 'hashing' && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[28px] leading-none font-bold tracking-tight">
            {percent}
            <span className="ml-1 text-base font-semibold text-ink-2">%</span>
          </span>
          <span className="text-sm text-ink-2">
            {formatLimit(item.bytesConfirmed)} din {formatLimit(item.size)} · {u.queue.partsConfirmed(done, item.partCount)}
          </span>
          {item.state === 'uploading' && item.speedBps !== null && (
            <span className="text-sm text-ink-2">
              {u.queue.speed(formatBytes(item.speedBps))}
              {item.etaS !== null && ` · ${u.queue.left(shortDuration(item.etaS))}`}
            </span>
          )}
        </div>
      )}

      {item.state === 'needs_file' && <p className="text-sm text-ink-2">{item.reopenable ? u.queue.needsFileReopen : u.queue.needsFileReselect}</p>}
      {item.state === 'failed' && item.error && (
        <p className="text-sm font-semibold text-crit-ink">
          {item.error.message}
          {item.traceId && (
            <span className="ml-2 font-normal text-ink-2">
              {u.queue.traceId}: <code translate="no" className="font-mono">{item.traceId}</code>
            </span>
          )}
        </p>
      )}
      {item.state === 'verified' && <VerifiedDetails item={item} />}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
          {item.clientSha256 && item.state !== 'verified' && (
            <span>
              {u.queue.clientHash}{' '}
              <code translate="no" title={item.clientSha256} className="font-mono">
                {shortHash(item.clientSha256)}
              </code>
            </span>
          )}
          {item.startedAsRole && (
            <span>
              {u.queue.startedAs} <b className="font-semibold text-ink">{t.auth.roles[item.startedAsRole].label}</b>
            </span>
          )}
          {item.policyVersion !== undefined && <span>{u.queue.policyAtStart(item.policyVersion)}</span>}
        </div>
        <RowActions item={item} nameId={nameId} />
      </div>
    </li>
  );
}

function VerifiedDetails({ item }: { item: UploadItemView }) {
  const u = useT().upload;
  const same = item.verdict === 'match' && item.clientSha256 && item.clientSha256 === item.serverSha256;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {item.category === 'fault_records' && typeof item.availableAfterMs === 'number' && (
        <span className="text-base font-bold">{u.queue.availableIn(formatDuration(item.availableAfterMs))}</span>
      )}
      {same && (
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-ok-ink" />
          {u.queue.bothHashes}{' '}
          <code translate="no" title={item.clientSha256} className="font-mono">
            {shortHash(item.clientSha256!)}
          </code>
        </span>
      )}
      {item.storage && <Tag>{item.usedFallback ? u.queue.fallback(u.storages[item.storage]) : u.queue.storedOn(u.storages[item.storage])}</Tag>}
      {item.fileId && (
        <Link href={`/files/${encodeURIComponent(item.fileId)}`} className="font-semibold text-link underline underline-offset-2">
          {u.queue.openFile}
        </Link>
      )}
    </div>
  );
}

/** The actions that fit the row's state. Names are "visible label + file name" (A11Y-12, WCAG 2.5.3). */
function RowActions({ item, nameId }: { item: UploadItemView; nameId: string }) {
  const u = useT().upload;
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const { id, state } = item;
  const resumable = state === 'failed' && item.failReason !== undefined && RESUMABLE.includes(item.failReason);
  const reselect = (state === 'needs_file' && !item.reopenable) || (state === 'failed' && item.failReason === 'different_file');
  // Over (verified, or failed for good): dismissing the row needs no confirmation.
  const over = state === 'verified' || (state === 'failed' && !resumable && !reselect);

  const label = (key: string) => ({ id: `${uid}-${key}`, 'aria-labelledby': `${uid}-${key} ${nameId}` });

  return (
    <div className="flex flex-wrap gap-2">
      {RUNNING.includes(state) && (
        <Button {...label('pause')} variant="secondary" size="sm" onClick={() => uploadEngine.pause(id)}>
          <Pause aria-hidden="true" />
          {u.queue.actions.pause}
        </Button>
      )}
      {state === 'paused' && (
        <Button {...label('resume')} variant="secondary" size="sm" onClick={() => uploadEngine.resume(id)}>
          <Play aria-hidden="true" />
          {u.queue.actions.resume}
        </Button>
      )}
      {resumable && (
        <Button {...label('retry')} variant="secondary" size="sm" onClick={() => uploadEngine.resume(id)}>
          <RotateCcw aria-hidden="true" />
          {u.queue.actions.retry}
        </Button>
      )}
      {/* Called straight from the click, before any await, so Chrome may ask for read access (upload-engine.md §8.5). */}
      {state === 'needs_file' && item.reopenable && (
        <Button {...label('reopen')} variant="secondary" size="sm" onClick={() => void uploadEngine.grantFileAccess(id)}>
          <Play aria-hidden="true" />
          {u.queue.actions.reopen}
        </Button>
      )}
      {reselect && (
        <>
          <Button {...label('reselect')} variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <FileSearch aria-hidden="true" />
            {u.queue.actions.reselect}
          </Button>
          <input
            ref={fileRef}
            type="file"
            hidden
            tabIndex={-1}
            data-reattach={id}
            aria-label={u.queue.actions.reselect}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void uploadEngine.reattach(id, file);
            }}
          />
        </>
      )}
      {over ? (
        <Button {...label('dismiss')} variant="quiet" size="sm" onClick={() => void uploadEngine.cancel(id)}>
          {u.queue.actions.dismiss}
        </Button>
      ) : (
        <CancelButton id={id} buttonId={`${uid}-cancel`} nameId={nameId} displayName={item.displayName} />
      )}
    </div>
  );
}

/** Cancelling drops the parts already sent, so it asks first; focus starts on the safe choice (Radix). */
function CancelButton({ id, buttonId, nameId, displayName }: { id: string; buttonId: string; nameId: string; displayName: string }) {
  const u = useT().upload;
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button id={buttonId} variant="quiet" size="sm" aria-labelledby={`${buttonId} ${nameId}`}>
          {u.queue.actions.cancel}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-(--fg-scrim)" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card bg-card p-6 shadow-e3">
          <AlertDialog.Title className="text-xl font-bold break-words">
            {u.queue.cancelTitle} <SafeName name={displayName} className="max-w-full align-bottom" />?
          </AlertDialog.Title>
          <AlertDialog.Description className="text-ink-2">{u.queue.cancelBody}</AlertDialog.Description>
          <div className="flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">{u.queue.cancelKeep}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={() => void uploadEngine.cancel(id)}>
                {u.queue.cancelConfirm}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
