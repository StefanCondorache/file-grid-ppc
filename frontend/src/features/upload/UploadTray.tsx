'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SafeName } from '@/components/SafeName';
import { useT } from '@/lib/i18n';
import { ro } from '@/lib/i18n/ro';
import { RUNNING } from '@/lib/upload/engine';
import { formatLimit } from '@/lib/upload/plan';
import { useUploadStore, type UploadItemView } from '@/lib/upload/store';
import { uploadAnnouncements, type Announcement } from './announce';

/** Global upload tray: compact progress of every upload plus a live region for screen readers. */
export function UploadTray() {
  const t = useT();
  const u = t.upload;
  const items = Object.values(useUploadStore((s) => s.items));
  const [open, setOpen] = useState(true);
  const [say, setSay] = useState<Announcement | null>(null);
  const prevRef = useRef<Record<string, UploadItemView>>({});

  useEffect(() => {
    const unsub = useUploadStore.subscribe((s) => {
      for (const item of Object.values(s.items)) {
        const prev = prevRef.current[item.id];
        if (prev) {
          const a = uploadAnnouncements(prev, item);
          if (a) setSay(a);
        }
      }
      prevRef.current = s.items;
    });
    prevRef.current = useUploadStore.getState().items;
    return unsub;
  }, []);

  const running = items.filter((i) => RUNNING.includes(i.state)).length;
  const verified = items.filter((i) => i.state === 'verified').length;
  const summary = [running > 0 && `${running} în curs`, verified > 0 && `${verified} ${verified === 1 ? 'verificat' : 'verificate'}`]
    .filter(Boolean)
    .join(' · ') || u.queue.summary(items.length, 0);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {say?.priority === 'polite' ? say.text : ''}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {say?.priority === 'assertive' ? say.text : ''}
      </div>
      {items.length > 0 && (
        <section
          aria-label={u.queue.title}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="fixed right-4 bottom-4 z-30 w-[min(92vw,360px)] rounded-card border border-border bg-card shadow-e3"
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-bold"
          >
            <span>{summary}</span>
            {open ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronUp aria-hidden="true" className="size-4" />}
          </button>
          {open && (
            <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto border-t border-border px-4 py-3">
              {items.map((i) => (
                <TrayRow key={i.id} item={i} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function TrayRow({ item }: { item: UploadItemView }) {
  const t = useT();
  const u = t.upload;
  const percent = item.state === 'verified' ? 100 : item.size > 0 ? Math.min(99, Math.floor((item.bytesConfirmed / item.size) * 100)) : 0;
  const storageDown = item.error?.code === 'STORAGE_UNAVAILABLE' ? (item.error.storage ?? 's3') : null;
  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 font-semibold">
          <SafeName name={item.displayName} className="max-w-full" />
        </span>
        <span className="shrink-0 text-ink-2">
          {u.stateLabel[item.state]}
          {item.state === 'uploading' && ` · ${percent}%`}
        </span>
      </div>
      <div className="flex justify-between gap-2 text-xs text-ink-2">
        <span>{formatLimit(item.size)}</span>
        {item.startedAsRole && (
          <span>
            {u.queue.startedAs.toLowerCase()} {t.auth.roles[item.startedAsRole].label}
          </span>
        )}
      </div>
      {item.state === 'verified' && item.storage && item.usedFallback && (
        <span className="text-xs">{u.queue.fallback(u.storages[item.storage])}</span>
      )}
      {storageDown && <span className="text-xs text-crit-ink">{ro.upload.tray.storageUnavailable(u.storages[storageDown])}</span>}
    </li>
  );
}
