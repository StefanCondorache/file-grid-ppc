import { describe, expect, it } from 'vitest';
import { persistableHandle, safeMetadata, toPersistable, type PersistInput } from './pii';
import { bitsetClear, bitsetHas, bitsetNew, bitsetSet, createRepo } from './repo';

let n = 0;
const freshRepo = () => createRepo(`filegrid-uploads-test-${++n}`);

function input(over: Partial<PersistInput> = {}): PersistInput {
  return {
    localId: `l-${Math.random().toString(36).slice(2)}`,
    userId: 'u1',
    startedByRole: 'teren',
    clientKey: crypto.randomUUID(),
    uploadId: null,
    category: 'drone_videos',
    state: 'queued',
    fileName: 'drona_0412.mp4',
    nameHash: 'a'.repeat(64),
    size: 3 * 1024 * 1024,
    lastModified: 1_700_000_000_000,
    type: 'video/mp4',
    metadata: { kind: 'drone', lineSection: 'LEA 110 kV', zone: 'muntenia', inspectionDate: '2026-11-14' },
    displayName: 'drona_0412.mp4',
    policy: null,
    chunkSize: null,
    partCount: null,
    confirmed: bitsetNew(0),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

const connection = () =>
  input({
    category: 'connection_documents',
    fileName: 'CI_Popescu_Ion_1960101410019.pdf',
    type: 'application/pdf',
    displayName: 'Document racordare nr. R-77',
    metadata: { kind: 'connection', requestNumber: 'R-77', documentType: 'act_identitate', applicantName: 'Ion Popescu', cnp: '1960101410019', address: 'Str. X 1', zone: 'banat' },
  });

describe('bitset', () => {
  it('sets and reads 1-based bits without mutating the input', () => {
    const a = bitsetNew(10);
    const b = bitsetSet(a, 10);
    expect(bitsetHas(a, 10)).toBe(false);
    expect(bitsetHas(b, 10)).toBe(true);
    expect(bitsetHas(b, 1)).toBe(false);
    expect(b.length).toBe(2);
  });

  it('clears a bit without mutating the input', () => {
    const a = bitsetSet(bitsetSet(bitsetNew(9), 2), 9);
    const b = bitsetClear(a, 9);
    expect([bitsetHas(a, 9), bitsetHas(b, 9), bitsetHas(b, 2)]).toEqual([true, false, true]);
    expect(bitsetClear(bitsetNew(0), 5)).toEqual(new Uint8Array(0));
  });
});

describe('PII allow-list', () => {
  it('keeps only the allow-listed metadata per category', () => {
    expect(safeMetadata('connection_documents', connection().metadata)).toEqual({ kind: 'connection', requestNumber: 'R-77', documentType: 'act_identitate', zone: 'banat' });
    expect(safeMetadata('fault_records', { kind: 'fault', zone: 'dobrogea', substation: 'PT 12', eventTime: 'x', severity: 'high', note: 'free text' })).toEqual({
      kind: 'fault', zone: 'dobrogea', substation: 'PT 12', eventTime: 'x', severity: 'high',
    });
  });

  it('never stores a file handle for connection documents', () => {
    const handle = { kind: 'file', name: 'stub' };
    expect(persistableHandle('connection_documents', handle)).toBeNull();
    expect(persistableHandle('drone_videos', handle)).toBe(handle);
  });
});

describe('upload repo (IndexedDB)', () => {
  it('round-trips a record and its handle', async () => {
    const repo = freshRepo();
    const rec = toPersistable(input(), 'drone_videos');
    await repo.put(rec);
    await repo.putHandle(rec.localId, { kind: 'file', name: 'stub' });
    const stored = (await repo.get(rec.localId))!;
    // fake-indexeddb clones typed arrays into another realm: compare the bytes, not the prototype.
    expect({ ...stored, confirmed: Array.from(stored.confirmed) }).toEqual({ ...rec, confirmed: Array.from(rec.confirmed) });
    expect(await repo.getHandle(rec.localId)).toEqual({ kind: 'file', name: 'stub' });
    expect(rec.fingerprint.name).toBe('drona_0412.mp4');
  });

  it('never stores personal data', async () => {
    const repo = freshRepo();
    const rec = toPersistable(connection(), 'connection_documents');
    await repo.put(rec);
    await repo.putHandle(rec.localId, persistableHandle('connection_documents', { kind: 'file' }));
    const json = JSON.stringify(await repo.get(rec.localId));
    for (const forbidden of ['cnp', 'applicantName', 'address', 'fileName', 'handle', '1960101410019', 'Popescu']) {
      expect(json).not.toContain(forbidden);
    }
    expect(await repo.getHandle(rec.localId)).toBeUndefined();
  });

  it('lists only the records of the given user', async () => {
    const repo = freshRepo();
    const a = toPersistable(input({ userId: 'u1' }), 'drone_videos');
    const b = toPersistable(input({ userId: 'u2' }), 'drone_videos');
    await repo.put(a);
    await repo.put(b);
    expect((await repo.listFor('u2')).map((r) => r.localId)).toEqual([b.localId]);
  });

  it('marks confirmed parts and keeps earlier ones', async () => {
    const repo = freshRepo();
    const rec = toPersistable(input({ partCount: 12, confirmed: bitsetNew(12) }), 'drone_videos');
    await repo.put(rec);
    await Promise.all([repo.markPart(rec.localId, 3), repo.markPart(rec.localId, 12)]);
    const stored = (await repo.get(rec.localId))!;
    expect([3, 12].map((p) => bitsetHas(stored.confirmed, p))).toEqual([true, true]);
    expect(bitsetHas(stored.confirmed, 4)).toBe(false);
  });

  it('removes a record with its handle', async () => {
    const repo = freshRepo();
    const rec = toPersistable(input(), 'drone_videos');
    await repo.put(rec);
    await repo.putHandle(rec.localId, { kind: 'file' });
    await repo.remove(rec.localId);
    expect(await repo.get(rec.localId)).toBeUndefined();
    expect(await repo.getHandle(rec.localId)).toBeUndefined();
  });

  it('purges records untouched for more than 24 h', async () => {
    const repo = freshRepo();
    const day = 24 * 60 * 60 * 1000;
    const old = toPersistable(input({ updatedAt: Date.now() - day - 1 }), 'drone_videos');
    const recent = toPersistable(input({ updatedAt: Date.now() - day + 60_000 }), 'drone_videos');
    await repo.put(old);
    await repo.put(recent);
    expect(await repo.purgeOlderThan(day)).toBe(1);
    expect(await repo.get(old.localId)).toBeUndefined();
    expect(await repo.get(recent.localId)).toBeDefined();
  });
});
