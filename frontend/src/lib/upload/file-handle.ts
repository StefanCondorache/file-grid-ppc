/**
 * File-system handles (Chromium) that let a reloaded upload get its file back without a file dialog
 * (upload-engine.md §8.3, §8.5; ADR-0004). Other browsers have no handle and fall back to a re-select.
 * The permission methods and `getAsFileSystemHandle` are not in TypeScript's DOM types yet, so they are typed here.
 */

type ReadAccess = { mode: 'read' };
const READ: ReadAccess = { mode: 'read' };

/** A FileSystemFileHandle with the permission methods Chromium adds to it. */
interface PermissionedFileHandle extends FileSystemFileHandle {
  queryPermission?(descriptor: ReadAccess): Promise<PermissionState>;
  requestPermission?(descriptor: ReadAccess): Promise<PermissionState>;
}

type DropItemWithHandle = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };

/** Values come back from IndexedDB, so nothing is trusted: a file handle has `kind: 'file'` and `getFile()`. */
function isFileHandle(value: unknown): value is PermissionedFileHandle {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Partial<PermissionedFileHandle>;
  return h.kind === 'file' && typeof h.getFile === 'function';
}

/** The code runs inside a click or key press, so Chrome may show its permission prompt. */
function inUserGesture(): boolean {
  return typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true;
}

/**
 * The handle of a dropped file (Chromium), stored so the file can be reopened after a reload. Call it synchronously
 * in the drop handler, for every item, before any `await`: the item list is emptied once the event returns. Null
 * when the browser has no handle API, the item is a folder or text, or the drop source gives no handle.
 */
export async function captureHandle(item: DataTransferItem): Promise<FileSystemFileHandle | null> {
  const get = (item as DropItemWithHandle).getAsFileSystemHandle;
  if (item.kind !== 'file' || typeof get !== 'function') return null;
  try {
    const handle = await get.call(item);
    return isFileHandle(handle) ? handle : null;
  } catch {
    return null;
  }
}

/**
 * The file behind a stored handle. Read access is checked first (`queryPermission`); while it is granted ("Allow on
 * every visit") the file comes back with no click. Otherwise Chrome is asked (`requestPermission`) only inside a
 * user gesture, since it refuses outside one: without a gesture the answer is `'needs_permission'` (one click on the
 * row brings the file back). Null when the file must be re-selected: access refused, the file moved or deleted, or
 * the value is not a file handle. The caller still checks it is the same file (upload-engine.md §8.4).
 */
export async function reopen(handle: unknown): Promise<File | 'needs_permission' | null> {
  if (!isFileHandle(handle)) return null;
  try {
    let access: PermissionState = handle.queryPermission ? await handle.queryPermission(READ) : 'granted';
    if (access === 'prompt' && handle.requestPermission && inUserGesture()) access = await handle.requestPermission(READ);
    if (access === 'granted') return await handle.getFile();
    return access === 'prompt' ? 'needs_permission' : null;
  } catch {
    // NotFoundError (moved or deleted), NotAllowedError, SecurityError: only a re-select brings the file back.
    return null;
  }
}
