// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashBlob } from '@/lib/upload/hash-core';
import type { HashClient } from '@/lib/upload/hasher';
import { BUFFER_LIMIT, downloadAndVerify, fileNameFrom, saveBlobViaAnchor } from './verify';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hasher: HashClient = {
  hash: (file, chunkSize, onProgress, signal) => hashBlob(file, chunkSize, onProgress, signal),
  sample: () => Promise.resolve({}),
};

function contentResponse(bytes: Uint8Array, storedSha: string, init: { cutAtEnd?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
      c.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
      if (init.cutAtEnd) c.error(new Error('connection reset'));
      else c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Avarie stația Nord.pdf')}`,
      'X-File-SHA256': storedSha,
      ETag: `"${storedSha}"`,
      'X-Trace-Id': 'trace-dl-1',
    },
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-hdr' } });

describe('downloadAndVerify', () => {
  it('matching bytes → Verificat, saved once with the server file name', async () => {
    const bytes = new Uint8Array(randomBytes(300_000));
    const stored = sha(bytes);
    const saveFile = vi.fn();
    const progress: number[] = [];
    const fetchMock = vi.fn<(url: string | URL | Request) => Promise<Response>>(async () => contentResponse(bytes, stored));
    const r = await downloadAndVerify({ fileId: 'f-1', size: bytes.length, expectedSha256: stored, onProgress: (b) => progress.push(b), saveFile, fetch: fetchMock as unknown as typeof fetch, hasher });
    expect(r).toMatchObject({ mode: 'client_verified', state: 'verified', badge: 'Verificat', expectedSha256: stored, actualSha256: stored, nextStep: null });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect((saveFile.mock.calls[0]![0] as Blob).size).toBe(bytes.length);
    expect(saveFile.mock.calls[0]![1]).toBe('Avarie stația Nord.pdf');
    expect(progress.at(-1)).toBe(bytes.length);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/files\/f-1\/content$/);
  });

  it('uses X-File-SHA256 when the caller has no expected hash', async () => {
    const bytes = new Uint8Array(randomBytes(1000));
    const r = await downloadAndVerify({ fileId: 'f-1', size: bytes.length, saveFile: vi.fn(), fetch: async () => contentResponse(bytes, sha(bytes)), hasher });
    expect(r.state).toBe('verified');
  });

  it('one flipped byte → Fișier corupt detectat with expected and actual hashes, not saved', async () => {
    const bytes = new Uint8Array(randomBytes(200_000));
    const stored = sha(bytes);
    const flipped = bytes.slice();
    flipped[1234] = flipped[1234]! ^ 0xff;
    const saveFile = vi.fn();
    const r = await downloadAndVerify({ fileId: 'f-2', size: bytes.length, expectedSha256: stored, saveFile, fetch: async () => contentResponse(flipped, stored), hasher, storage: 's3' });
    expect(r).toMatchObject({ state: 'corrupt', badge: 'Fișier corupt detectat', expectedSha256: stored, actualSha256: sha(flipped), storage: 's3', traceId: 'trace-dl-1', nextStep: 'notify_storage_team' });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('maps a 409 FILE_CORRUPT body: both hashes, storage, trace ID and next step', async () => {
    const body = { code: 'FILE_CORRUPT', message: 'Fișierul este corupt.', traceId: 'trace-409', expectedSha256: 'A'.repeat(64), actualSha256: 'b'.repeat(64), storage: 'ftp' };
    const r = await downloadAndVerify({ fileId: 'f-3', size: 100, saveFile: vi.fn(), fetch: async () => json(409, body), hasher, hasFallbackCopy: true });
    expect(r).toMatchObject({ state: 'corrupt', expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64), storage: 'ftp', traceId: 'trace-409', nextStep: 'restore_from_backup' });
  });

  it('> 64 MiB without a picker → native download, then server verification (mode server_verified)', async () => {
    const startNativeDownload = vi.fn();
    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return json(200, { fileId: 'f-4', state: 'server_verified', expectedSha256: 'c'.repeat(64), actualSha256: 'c'.repeat(64), storage: 'db', verifiedAt: '2026-11-14T10:00:00Z', traceId: 'trace-v' });
    });
    const r = await downloadAndVerify({ fileId: 'f-4', size: BUFFER_LIMIT + 1, fetch: fetchMock as typeof fetch, hasher, startNativeDownload });
    expect(startNativeDownload).toHaveBeenCalledWith(expect.stringMatching(/\/files\/f-4\/content$/));
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(/\/files\/f-4\/verification$/);
    expect(calls[0]![1]?.method).toBe('POST');
    expect(new Headers(calls[0]![1]?.headers).get('X-Requested-With')).toBe('filegrid');
    expect(r).toMatchObject({ mode: 'server_verified', state: 'server_verified', badge: 'Verificat de server', storage: 'db', traceId: 'trace-v' });
  });

  it('a large file the server finds corrupt → corrupt result', async () => {
    const r = await downloadAndVerify({
      fileId: 'f-5', size: BUFFER_LIMIT + 1, hasher, startNativeDownload: vi.fn(),
      fetch: async () => json(200, { fileId: 'f-5', state: 'corrupt', expectedSha256: 'c'.repeat(64), actualSha256: 'd'.repeat(64), storage: 's3', verifiedAt: 'x', traceId: 't' }),
    });
    expect(r).toMatchObject({ mode: 'server_verified', state: 'corrupt', actualSha256: 'd'.repeat(64), nextStep: 'notify_storage_team' });
  });

  it('a connection cut twice mid-body falls back to server verification', async () => {
    const bytes = new Uint8Array(randomBytes(5000));
    const stored = sha(bytes);
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/verification')
        ? json(200, { fileId: 'f-6', state: 'corrupt', expectedSha256: stored, actualSha256: 'e'.repeat(64), storage: 's3', verifiedAt: 'x', traceId: 't6' })
        : contentResponse(bytes, stored, { cutAtEnd: true }),
    );
    const saveFile = vi.fn();
    const r = await downloadAndVerify({ fileId: 'f-6', size: bytes.length, expectedSha256: stored, saveFile, fetch: fetchMock as typeof fetch, hasher });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ state: 'corrupt', actualSha256: 'e'.repeat(64), traceId: 't6' });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('other errors surface as ApiError', async () => {
    await expect(downloadAndVerify({ fileId: 'f-7', size: 10, fetch: async () => json(403, { code: 'FORBIDDEN', message: 'Nu aveți acces.' }), hasher })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('saving', () => {
  it('revokes the Blob URL after the anchor click', async () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), style: {} as CSSStyleDeclaration } as unknown as HTMLAnchorElement;
    const doc = { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } } as unknown as Document;
    const url = { createObjectURL: vi.fn(() => 'blob:x-1'), revokeObjectURL: vi.fn() };
    saveBlobViaAnchor(new Blob(['abc']), 'a.txt', { doc, url });
    expect(click).toHaveBeenCalled();
    expect(anchor.download).toBe('a.txt');
    await new Promise((r) => setTimeout(r, 5));
    expect(url.revokeObjectURL).toHaveBeenCalledWith('blob:x-1');
  });

  it('reads filename* first, then filename', () => {
    expect(fileNameFrom(`attachment; filename="a.pdf"; filename*=UTF-8''%C8%99%C8%9B.pdf`, 'x')).toBe('șț.pdf');
    expect(fileNameFrom('attachment; filename="plain.csv"', 'x')).toBe('plain.csv');
    expect(fileNameFrom(null, 'fallback.bin')).toBe('fallback.bin');
  });
});
