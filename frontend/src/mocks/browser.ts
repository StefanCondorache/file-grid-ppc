import { setupWorker } from 'msw/browser';
import type { Group } from './groups';
import { buildHandlers } from './handlers';

/** Full-mock mode only (Task 5.10): the service worker serves every group. */
export async function startWorker(groups: readonly Group[] | 'all' = 'all') {
  const worker = setupWorker(...(await buildHandlers(groups)));
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  return worker;
}
