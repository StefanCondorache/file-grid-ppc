import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureHandle, reopen } from './file-handle';

const file = new File(['abc'], 'inspectie-linia-7.mp4', { type: 'video/mp4' });

/** A Chromium FileSystemFileHandle as far as reopen() looks at it. */
function handle(permission: PermissionState, opts: { afterRequest?: PermissionState; getFile?: () => Promise<File> } = {}) {
  return {
    kind: 'file' as const,
    name: file.name,
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => opts.afterRequest ?? 'granted'),
    getFile: vi.fn(opts.getFile ?? (async () => file)),
  };
}

function dropItem(kind: string, getAsFileSystemHandle?: () => Promise<unknown>): DataTransferItem {
  return { kind, type: 'video/mp4', getAsFile: () => file, getAsString: () => {}, webkitGetAsEntry: () => null, getAsFileSystemHandle } as unknown as DataTransferItem;
}

/** Transient user activation: the code runs inside a click (jsdom has no navigator.userActivation). */
function inClick(active: boolean): void {
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: active, hasBeenActive: active } });
}

afterEach(() => {
  delete (navigator as { userActivation?: unknown }).userActivation;
});

describe('captureHandle', () => {
  it('asks the drop item for its handle synchronously and keeps a file handle', async () => {
    const h = handle('granted');
    const get = vi.fn(async () => h);
    const pending = captureHandle(dropItem('file', get));
    expect(get).toHaveBeenCalledTimes(1); // before any await: the item list is emptied when the drop event returns
    expect(await pending).toBe(h);
  });

  it('gives null for a folder, a text item, a browser without the API or a failing drop source', async () => {
    expect(await captureHandle(dropItem('file', async () => ({ kind: 'directory', name: 'poze' })))).toBeNull();
    expect(await captureHandle(dropItem('string', async () => handle('granted')))).toBeNull();
    expect(await captureHandle(dropItem('file'))).toBeNull();
    expect(await captureHandle(dropItem('file', async () => null))).toBeNull();
    expect(await captureHandle(dropItem('file', () => Promise.reject(new DOMException('no', 'NotAllowedError'))))).toBeNull();
  });
});

describe('reopen', () => {
  it('returns the file at once while read access is still granted', async () => {
    const h = handle('granted');
    expect(await reopen(h)).toBe(file);
    expect(h.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it('outside a click it never prompts: needs_permission', async () => {
    const h = handle('prompt');
    expect(await reopen(h)).toBe('needs_permission');
    inClick(false);
    expect(await reopen(h)).toBe('needs_permission');
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.getFile).not.toHaveBeenCalled();
  });

  it('inside a click it asks for read access, then returns the file', async () => {
    inClick(true);
    const h = handle('prompt');
    expect(await reopen(h)).toBe(file);
    expect(h.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('a dismissed prompt still needs permission; a refusal needs a re-select', async () => {
    inClick(true);
    expect(await reopen(handle('prompt', { afterRequest: 'prompt' }))).toBe('needs_permission');
    expect(await reopen(handle('prompt', { afterRequest: 'denied' }))).toBeNull();
    expect(await reopen(handle('denied'))).toBeNull();
  });

  it('a moved or deleted file, or anything that is not a file handle, gives null', async () => {
    const gone = handle('granted', { getFile: () => Promise.reject(new DOMException('gone', 'NotFoundError')) });
    expect(await reopen(gone)).toBeNull();
    expect(await reopen(null)).toBeNull();
    expect(await reopen({ kind: 'directory', name: 'poze' })).toBeNull();
    expect(await reopen({ kind: 'file' })).toBeNull(); // a record from IndexedDB that lost its methods
  });
});
