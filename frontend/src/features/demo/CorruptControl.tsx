'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cleanName } from '@/components/clean-name';
import { apiUrl } from '@/lib/api/base';
import { qk } from '@/lib/api/query-keys';
import { useT } from '@/lib/i18n';
import { formatBytes } from '@/lib/i18n/format';
import { call, useRunAction } from './api';
import { ConfirmAction } from './ConfirmAction';
import { Panel } from './Panel';

/** The backend refuses to corrupt objects above 64 MiB (demo.service.ts MAX_CORRUPTION_READ). */
const MAX_CORRUPT_BYTES = 64 * 1024 * 1024;

type FileRow = { id: string; displayName: string; category: string; size: number; storage: string; integrity: string };
type Loose = Record<string, unknown>;

function toFiles(raw: unknown): FileRow[] {
  const items = raw && typeof raw === 'object' && Array.isArray((raw as Loose).data) ? ((raw as Loose).data as unknown[]) : [];
  return items
    .filter((f): f is Loose => !!f && typeof f === 'object' && typeof (f as Loose).id === 'string')
    .map((f) => ({
      id: String(f.id),
      displayName: cleanName(String(f.displayName ?? f.id)).text,
      category: String(f.category ?? ''),
      size: typeof f.size === 'number' ? f.size : 0,
      storage: String(f.storage ?? '').toLowerCase(),
      integrity: String(f.integrity ?? ''),
    }))
    .filter((f) => f.size > 0 && f.size <= MAX_CORRUPT_BYTES);
}

type Verification = { state: string; expectedSha256: string | null; actualSha256: string | null };

/** Corrupt a stored file in place (POST /demo/corruptions), then prove the detection (POST /files/{id}/verification). */
export function CorruptControl() {
  const t = useT();
  const d = t.demo;
  const run = useRunAction();
  const files = useQuery({
    queryKey: qk.files.list({ demo: 'corrupt', pageSize: 30 }),
    queryFn: () => call<unknown>('GET', '/files?pageSize=30&excludeGenerated=true'),
    select: toFiles,
  });
  const [picked, setPicked] = useState('');
  const [corrupted, setCorrupted] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const list = files.data ?? [];
  const fileId = picked || list[0]?.id || '';
  const file = list.find((f) => f.id === fileId);
  const label = (f: FileRow) => `${f.displayName} · ${(t.monitoring.categories as Record<string, string>)[f.category] ?? f.category} · ${(d.storages as Record<string, string>)[f.storage] ?? f.storage} · ${formatBytes(f.size)}`;

  const corrupt = () =>
    run(
      () => call<{ storage?: string }>('POST', '/demo/corruptions', { fileId }),
      (r) => {
        setCorrupted(fileId);
        setVerification(null);
        const storage = String(r?.storage ?? file?.storage ?? '');
        return d.corrupt.done((d.storages as Record<string, string>)[storage] ?? storage);
      },
    );

  const verify = (id: string) =>
    run(
      () => call<Verification>('POST', `/files/${id}/verification`),
      (r) => {
        setVerification(r);
        return r.state === 'corrupt'
          ? d.corrupt.verifiedCorrupt(String(r.expectedSha256 ?? '').slice(0, 12), String(r.actualSha256 ?? '').slice(0, 12))
          : d.corrupt.verifiedOk;
      },
    );

  return (
    <Panel id="corrupt-title" title={d.corrupt.title}>
      {files.isSuccess && list.length === 0 ? (
        <p className="text-sm text-ink-2">{d.corrupt.none}</p>
      ) : (
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          {d.corrupt.file}
          <select
            value={fileId}
            onChange={(e) => setPicked(e.target.value)}
            className="h-10 max-w-full rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink"
          >
            {list.length === 0 && <option value="">{d.corrupt.pick}</option>}
            {list.map((f) => (
              <option key={f.id} value={f.id}>
                {label(f)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        <ConfirmAction
          variant="danger"
          label={d.corrupt.action}
          title={d.corrupt.confirmTitle}
          body={d.corrupt.confirmBody(file?.displayName ?? '')}
          disabled={!fileId}
          onConfirm={corrupt}
        />
        {corrupted && (
          <>
            <Button variant="secondary" size="lg" onClick={() => void verify(corrupted)}>
              {d.corrupt.verify}
            </Button>
            <Button asChild variant="quiet" size="lg">
              <a href={apiUrl(`/files/${corrupted}/content`)} download>
                {d.corrupt.download}
              </a>
            </Button>
          </>
        )}
      </div>
      {verification && (
        <p data-state={verification.state} className={verification.state === 'corrupt' ? 'font-semibold text-crit-ink' : 'font-semibold text-ok-ink'}>
          {verification.state === 'corrupt' ? d.corrupt.verifiedCorrupt(String(verification.expectedSha256 ?? '').slice(0, 12), String(verification.actualSha256 ?? '').slice(0, 12)) : d.corrupt.verifiedOk}
        </p>
      )}
    </Panel>
  );
}
