import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PersistedUpload } from './types';

/** Bitset of confirmed parts: bit n-1 = part n (1-based). Pure helpers; they never mutate their input. */
export function bitsetNew(parts: number): Uint8Array {
  return new Uint8Array(Math.ceil(parts / 8));
}

export function bitsetHas(bits: Uint8Array, n: number): boolean {
  const i = n - 1;
  return ((bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
}

export function bitsetSet(bits: Uint8Array, n: number): Uint8Array {
  const i = n - 1;
  const next = new Uint8Array(Math.max(bits.length, (i >> 3) + 1));
  next.set(bits);
  next[i >> 3] = (next[i >> 3] ?? 0) | (1 << (i & 7));
  return next;
}

interface UploadDb extends DBSchema {
  uploads: { key: string; value: PersistedUpload; indexes: { byUser: string } };
  handles: { key: string; value: { localId: string; handle: unknown } };
}

export interface UploadRepo {
  put(r: PersistedUpload): Promise<void>;
  get(localId: string): Promise<PersistedUpload | undefined>;
  listFor(userId: string): Promise<PersistedUpload[]>;
  markPart(localId: string, n: number): Promise<void>;
  remove(localId: string): Promise<void>;
  purgeOlderThan(ms: number): Promise<number>;
  putHandle(localId: string, handle: unknown): Promise<void>;
  getHandle(localId: string): Promise<unknown>;
}

/** IndexedDB store `filegrid-uploads` v1 (upload-engine.md §8.1). Records only ever come from pii.toPersistable. */
export function createRepo(name = 'filegrid-uploads', now: () => number = Date.now): UploadRepo {
  let db: Promise<IDBPDatabase<UploadDb>> | null = null;
  const open = () =>
    (db ??= openDB<UploadDb>(name, 1, {
      upgrade(d) {
        d.createObjectStore('uploads', { keyPath: 'localId' }).createIndex('byUser', 'userId');
        d.createObjectStore('handles', { keyPath: 'localId' });
      },
    }));

  return {
    async put(r) {
      await (await open()).put('uploads', r);
    },
    async get(localId) {
      return (await open()).get('uploads', localId);
    },
    async listFor(userId) {
      return (await open()).getAllFromIndex('uploads', 'byUser', userId);
    },
    async markPart(localId, n) {
      const tx = (await open()).transaction('uploads', 'readwrite');
      const rec = await tx.store.get(localId);
      if (rec) await tx.store.put({ ...rec, confirmed: bitsetSet(rec.confirmed, n), updatedAt: now() });
      await tx.done;
    },
    async remove(localId) {
      const tx = (await open()).transaction(['uploads', 'handles'], 'readwrite');
      await Promise.all([tx.objectStore('uploads').delete(localId), tx.objectStore('handles').delete(localId), tx.done]);
    },
    async purgeOlderThan(ms) {
      const d = await open();
      const cutoff = now() - ms;
      const stale = (await d.getAll('uploads')).filter((r) => r.updatedAt < cutoff);
      const tx = d.transaction(['uploads', 'handles'], 'readwrite');
      await Promise.all([
        ...stale.flatMap((r) => [tx.objectStore('uploads').delete(r.localId), tx.objectStore('handles').delete(r.localId)]),
        tx.done,
      ]);
      return stale.length;
    },
    async putHandle(localId, handle) {
      const d = await open();
      if (handle === null || handle === undefined) await d.delete('handles', localId);
      else await d.put('handles', { localId, handle });
    },
    async getHandle(localId) {
      return (await (await open()).get('handles', localId))?.handle;
    },
  };
}
