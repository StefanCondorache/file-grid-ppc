import { notifyUnauthenticated } from '@/lib/auth/session-end';
import { createUploadApi, createXhrTransport } from './api';
import { createUploadEngine, type UploadEngine } from './engine';
import { setUploadControl } from './engine-port';
import { createWorkerHasher } from './hasher';
import { createNetMonitor, createPingProbe } from './net';
import { createRepo } from './repo';
import { publishToStore, type UploadItemView } from './store';
import { realClock } from './types';

let engine: UploadEngine | null = null;
const completedListeners = new Set<(view: UploadItemView) => void>();

/** React code listens for verified uploads (e.g. to refresh the files list) without the engine knowing React. */
export function onUploadCompleted(listener: (view: UploadItemView) => void): () => void {
  completedListeners.add(listener);
  return () => completedListeners.delete(listener);
}

/**
 * The browser's one upload engine (FA-24): a module singleton, so it survives navigation and re-login. Creating it
 * registers it as the UploadControl that auth uses to pause, restore and resume uploads (engine-port.ts).
 */
export function getUploadEngine(): UploadEngine {
  if (engine) return engine;
  if (typeof window === 'undefined') throw new Error('The upload engine runs in the browser only');
  const net = createNetMonitor({ win: window, probe: createPingProbe(), rng: Math.random, clock: realClock });
  engine = createUploadEngine({
    api: createUploadApi(),
    transport: createXhrTransport(),
    repo: createRepo(),
    hasher: createWorkerHasher(),
    net,
    clock: realClock,
    rng: Math.random,
    publish: publishToStore,
    onSessionExpired: (error) => notifyUnauthenticated(error),
    onCompleted: (view) => completedListeners.forEach((l) => l(view)),
  });
  setUploadControl(engine);
  return engine;
}
