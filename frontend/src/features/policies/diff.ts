import type { PolicyView } from '@/lib/upload/contract';
import type { StorageId } from '@/lib/upload/types';
import type { PolicyUpdate } from './schema';

export const STORAGE_LABEL: Record<StorageId, string> = { s3: 'S3', ftp: 'FTP', db: 'PostgreSQL' };
const storage = (s: StorageId | null | undefined) => (s ? STORAGE_LABEL[s] : 'fără rezervă');
const mib = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

/** Only the fields that changed, with Romanian labels. */
export function diffPolicy(a: PolicyView, b: PolicyUpdate): { field: string; from: string; to: string }[] {
  const rows: { field: string; from: string; to: string }[] = [];
  const add = (field: string, from: string, to: string) => {
    if (from !== to) rows.push({ field, from, to });
  };
  add('Storage principal', storage(a.primaryStorage), storage(b.primaryStorage));
  add('Storage de rezervă', storage(a.fallbackStorage), storage(b.fallbackStorage));
  add('Criptare la stocare', a.encryptionAtRest ? 'activă' : 'inactivă', b.encryptionAtRest ? 'activă' : 'inactivă');
  add('Dimensiunea părții', mib(a.chunkSize), mib(b.chunkSize));
  add('Încărcări paralele', String(a.maxParallel), String(b.maxParallel));
  add('Concurență pe server', String(a.maxConcurrency), String(b.maxConcurrency));
  return rows;
}
