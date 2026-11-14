import type { QueryClient } from '@tanstack/react-query';
import type { UploadControl } from '@/lib/upload/engine-port';

export type ClearDeps = {
  queryClient: QueryClient;
  closeStream: () => void;
  uploads: UploadControl;
  broadcast?: Pick<BroadcastChannel, 'postMessage'> | null;
};

/**
 * The only session-end path (SR-19, ADR-0007): wipe cached server data, close the stream, pause uploads.
 * Upload records are kept (no PII, keyed by real user) so the same user resumes after re-login.
 */
export function clearClientState(deps: ClearDeps, reason: 'logout' | 'session' | '401'): void {
  deps.queryClient.clear();
  deps.closeStream();
  deps.uploads.pauseAll(reason === 'logout' ? 'logout' : 'session');
  if (reason === 'logout') deps.broadcast?.postMessage({ type: 'logout' });
}
