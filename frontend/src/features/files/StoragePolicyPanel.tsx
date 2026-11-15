import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { formatInt } from '@/lib/i18n/format';
import type { FileDetail } from './queries';

function Fact({ term, value, note }: { term: string; value: ReactNode; note?: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control bg-surface-2 p-4">
      <dt className="text-xs font-semibold tracking-wide text-ink-2 uppercase">{term}</dt>
      <dd className="flex flex-col gap-0.5">
        <span className="text-2xl leading-tight font-bold tracking-tight">{value}</span>
        {note && <span className="text-[13px] text-ink-2">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * Where the file lives and under which rules (FE-05, F2): the storage as a label (S3 / FTP / DB), never a URL, key,
 * bucket or path (N7); the policy version that placed it; encryption at rest with its algorithm; whether the write
 * went to the fallback (FE-08). Beat 7 reads its summary line: "Stocat pe FTP · politica v4".
 */
export function StoragePolicyPanel({ file }: { file: FileDetail }) {
  const t = useT();
  const s = t.files.detail.storage;
  const storage = t.files.storage[file.storage] ?? String(file.storage).toUpperCase();
  const version = formatInt(file.policyVersion);
  const category = t.files.categories[file.category] ?? file.category;
  const encryptionNote = file.encryptedAtRest ? file.encryptionAlgorithm : file.category === 'connection_documents' ? null : s.noPersonalData;
  return (
    <Card aria-labelledby="file-storage-h" className="flex flex-col gap-4">
      <h2 id="file-storage-h" className="text-lg font-bold">
        {s.title}
      </h2>
      <p className="text-base font-semibold">{s.summary(storage, version)}</p>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Fact term={s.storedOn} value={storage} note={file.usedFallback ? s.onFallback : s.primary} />
        <Fact term={s.policy} value={`v${version}`} note={s.policyFor(category)} />
        <Fact term={s.encryption} value={file.encryptedAtRest ? s.yes : s.no} note={encryptionNote} />
        <Fact term={s.fallbackUsed} value={file.usedFallback ? s.yes : s.no} note={file.usedFallback ? s.fallbackAuto : null} />
      </dl>
    </Card>
  );
}
