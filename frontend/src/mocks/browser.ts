import { setupWorker } from 'msw/browser';
import type { Group } from './groups';
import { buildHandlers } from './handlers';

let started: ReturnType<typeof boot> | null = null;

async function boot(groups: readonly Group[] | 'all') {
  const worker = setupWorker(...(await buildHandlers(groups)));
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  return worker;
}

/**
 * Full-mock mode only (Task 5.10): the service worker serves every group. Started once per page:
 * React runs MockBootstrap's effect twice in development, and two workers would each run every
 * handler, so every mocked write (a policy version, an upload, an audit event) happened twice.
 */
export function startWorker(groups: readonly Group[] | 'all' = 'all') {
  started ??= boot(groups);
  return started;
}
