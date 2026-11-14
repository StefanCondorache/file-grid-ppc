import { describe, expect, it } from 'vitest';
import { ro } from '@/lib/i18n/ro';
import { isTerminal, transition } from './machine';
import { UPLOAD_STATES, type UploadEvent, type UploadState } from './types';

// One row per transition of docs/frontend/architecture/upload-engine.md §11 (adapted to the real contract:
// the session is created at the start of `hashing`, because the part size comes from the server).
const ROWS: [UploadState, UploadEvent, UploadState][] = [
  ['queued', { type: 'SLOT_FREE' }, 'hashing'],
  ['queued', { type: 'FILE_MISSING' }, 'needs_file'],
  ['queued', { type: 'FILE_ATTACHED', to: 'uploading' }, 'uploading'],
  ['hashing', { type: 'FILE_MISSING' }, 'needs_file'],
  ['hashing', { type: 'HASH_DONE' }, 'uploading'],
  ['hashing', { type: 'FAIL', reason: 'file_changed' }, 'failed'],
  ['uploading', { type: 'PART_OK' }, 'uploading'],
  ['uploading', { type: 'ALL_PARTS_OK' }, 'verifying'],
  ['uploading', { type: 'RETRY_SCHEDULED' }, 'connection_lost'],
  ['uploading', { type: 'OFFLINE' }, 'connection_lost'],
  ['connection_lost', { type: 'PART_OK' }, 'uploading'],
  ['connection_lost', { type: 'RETRY_FIRES' }, 'uploading'],
  ['connection_lost', { type: 'ONLINE_CONFIRMED' }, 'uploading'],
  ['uploading', { type: 'PAUSE', reason: 'user' }, 'paused'],
  ['connection_lost', { type: 'PAUSE', reason: 'user' }, 'paused'],
  ['hashing', { type: 'PAUSE', reason: 'user' }, 'paused'],
  ['paused', { type: 'RESUME', to: 'uploading' }, 'uploading'],
  ['paused', { type: 'RESUME', to: 'hashing' }, 'hashing'],
  ['uploading', { type: 'PAUSE', reason: 'session' }, 'paused'],
  ['verifying', { type: 'PAUSE', reason: 'session' }, 'paused'],
  ['paused', { type: 'RESUME', to: 'verifying' }, 'verifying'],
  ['needs_file', { type: 'FILE_ATTACHED', to: 'uploading' }, 'uploading'],
  ['needs_file', { type: 'FILE_ATTACHED', to: 'hashing' }, 'hashing'],
  ['needs_file', { type: 'FAIL', reason: 'different_file' }, 'failed'],
  ['verifying', { type: 'COMPLETE_MATCH' }, 'verified'],
  ['verifying', { type: 'FAIL', reason: 'checksum_mismatch' }, 'failed'],
  ['verifying', { type: 'COMPLETE_PENDING' }, 'verifying'],
  ['verifying', { type: 'PARTS_MISSING' }, 'uploading'],
  ['uploading', { type: 'FAIL', reason: 'forbidden' }, 'failed'],
  ['connection_lost', { type: 'FAIL', reason: 'retries_exhausted' }, 'failed'],
  ['failed', { type: 'RETRY', to: 'uploading' }, 'uploading'],
  ['failed', { type: 'FILE_ATTACHED', to: 'uploading' }, 'uploading'],
  ['uploading', { type: 'RESTORE' }, 'queued'],
  ['connection_lost', { type: 'RESTORE' }, 'queued'],
  ['verifying', { type: 'RESTORE' }, 'queued'],
];

// Impossible events are ignored: the state does not change.
const IGNORED: [UploadState, UploadEvent][] = [
  ['queued', { type: 'HASH_DONE' }],
  ['queued', { type: 'ALL_PARTS_OK' }],
  ['hashing', { type: 'COMPLETE_MATCH' }],
  ['uploading', { type: 'RESUME', to: 'hashing' }],
  ['uploading', { type: 'COMPLETE_MATCH' }],
  ['paused', { type: 'PART_OK' }],
  ['paused', { type: 'ONLINE_CONFIRMED' }],
  ['needs_file', { type: 'RESUME', to: 'uploading' }],
  ['verified', { type: 'FAIL', reason: 'unknown' }],
  ['verified', { type: 'PAUSE', reason: 'user' }],
  ['verified', { type: 'RESTORE' }],
  ['failed', { type: 'PART_OK' }],
  ['failed', { type: 'PAUSE', reason: 'session' }],
  ['verifying', { type: 'SLOT_FREE' }],
];

describe('upload state machine', () => {
  it.each(ROWS)('%s + %o → %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it.each(IGNORED)('%s ignores %o', (from, event) => {
    expect(transition(from, event)).toBe(from);
  });

  it('a restored record never starts in uploading', () => {
    for (const s of UPLOAD_STATES) expect(transition(s, { type: 'RESTORE' })).not.toBe('uploading');
  });

  it('only verified and failed are terminal', () => {
    expect(UPLOAD_STATES.filter(isTerminal)).toEqual(['verified', 'failed']);
  });

  it('has a Romanian label for every state', () => {
    expect(ro.upload.stateLabel).toEqual({
      queued: 'în așteptare',
      hashing: 'se calculează amprenta',
      uploading: 'se încarcă',
      paused: 'în pauză',
      connection_lost: 'conexiune pierdută',
      verifying: 'se verifică',
      verified: 'verificat',
      failed: 'eșuat',
      needs_file: 'alege din nou fișierul',
    });
  });
});
