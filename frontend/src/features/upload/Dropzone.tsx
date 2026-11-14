'use client';

import { CloudUpload, OctagonX, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { SafeName } from '@/components/SafeName';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { captureHandle } from '@/lib/upload/file-handle';

/** A chosen file and, for a drop in Chromium, its handle: it lets the upload reopen the file after a reload. */
export interface PickedFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

/** A file refused before any request (policy pre-validation, Review Focus 5), with its Romanian reasons. */
export interface RejectedFile {
  name: string;
  reasons: readonly string[];
}

export interface DropzoneProps {
  /** Accepted types and the size limit, from the policy ("MP4, MOV · maximum 4 GB (politica v3)"). */
  hint: string;
  onFiles(files: PickedFile[]): void;
  /** Id of the "Alege fișiere" button, so an error summary can link to it. */
  buttonId?: string;
  /** `accept` of the native picker (the policy's MIME types); a hint only, the policy check still runs. */
  accept?: string;
  rejected?: readonly RejectedFile[];
  /** Id of a message about the file choice (for example "no file chosen"), read with the button. */
  describedBy?: string;
  className?: string;
}

const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Upload drop zone (components.md, A11Y-13): drag-and-drop is a shortcut, never the only way. It always holds a real
 * "Alege fișiere" button that opens the native multi-file picker. A drop captures each file's handle synchronously,
 * before the item list is emptied, so a reload can get the file back without a dialog (upload-engine.md §8.5).
 */
export function Dropzone({ hint, onFiles, buttonId, accept, rejected = [], describedBy, className }: DropzoneProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const uid = useId();

  // A file dropped next to the zone would make the browser open it in this tab and leave the app: refuse it.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') && !zoneRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      }
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // choosing the same file again fires `change` again
    if (files.length > 0) onFiles(files.map((file) => ({ file, handle: null })));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const items = Array.from(e.dataTransfer.items ?? []).filter((item) => item.kind === 'file');
    // Synchronously, for every item, before any await: Chromium empties the list once this handler returns.
    const picks = items.map((item) => ({ file: item.getAsFile(), handle: captureHandle(item) }));
    if (picks.length === 0) {
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) onFiles(files.map((file) => ({ file, handle: null })));
      return;
    }
    void Promise.all(picks.map(async (p) => ({ file: p.file, handle: await p.handle }))).then((done) => {
      const files = done.filter((p): p is PickedFile => p.file !== null);
      if (files.length > 0) onFiles(files);
    });
  }

  const state = over ? 'over' : rejected.length > 0 ? 'rejected' : 'idle';

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- dropping is a pointer shortcut; the "Alege fișiere" button inside is the keyboard path (A11Y-13, WCAG 2.5.7) */}
      <div
        ref={zoneRef}
        role="group"
        aria-labelledby={`${uid}-title`}
        data-dropzone=""
        data-state={state}
        onDragEnter={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!isFileDrag(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-wrap items-center gap-x-5 gap-y-3 rounded-panel border-2 border-dashed border-input bg-sunken p-6 transition-colors duration-(--fg-dur-fast)',
          state === 'over' && 'border-solid border-brand-cyan bg-info-tint outline-2 outline-offset-2 outline-brand-cyan',
          state === 'rejected' && 'border-crit',
        )}
      >
        <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-full bg-surface text-ink">
          <CloudUpload className="size-7" strokeWidth={1.5} />
        </span>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <span id={`${uid}-title`} className="text-[17px] font-bold">
            {t.upload.dropzone.title}
          </span>
          <span className="text-ink-2">
            {t.upload.dropzone.orPick} · {hint}
          </span>
        </div>
        <Button id={buttonId} type="button" size="lg" aria-describedby={describedBy} onClick={() => inputRef.current?.click()}>
          <Upload aria-hidden="true" />
          {t.upload.dropzone.choose}
        </Button>
        <input ref={inputRef} type="file" multiple hidden accept={accept} tabIndex={-1} aria-label={t.upload.dropzone.choose} onChange={onPick} />
      </div>
      {rejected.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm font-semibold text-crit-ink">
          {rejected.map((r, i) => (
            <li key={i} className="flex min-w-0 items-start gap-1.5">
              <OctagonX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <SafeName name={r.name} className="max-w-full align-bottom" />
                {': '}
                <span>{r.reasons.join(' ')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
