'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { announce } from '@/lib/a11y/announcer';
import { apiUrl } from '@/lib/api/base';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';
import { createBridge, type Bridge } from '@/lib/live/bridge';
import { liveHandle } from '@/lib/live/registry';
import { connectStream } from '@/lib/live/stream';
import { useAppStore } from '@/stores/app-store';

let uploadHint: (uploadId: string) => void = () => {};

/** The upload engine (6b) registers how it reacts to `upload.verified` hints. */
export function setUploadHint(fn: (uploadId: string) => void): void {
  uploadHint = fn;
}

/** Mounts the single live connection for the session (frontend-architecture §4). Renders nothing. */
export function LiveBridge() {
  const qc = useQueryClient();
  const paused = useAppStore((s) => s.livePaused);
  const setLive = useAppStore((s) => s.setLive);
  const markEvent = useAppStore((s) => s.markEvent);
  const bridgeRef = useRef<Bridge | null>(null);

  useEffect(() => {
    const bridge = createBridge(qc, { announce: (m) => announce(m), uploadHint: (id) => uploadHint(id) });
    bridgeRef.current = bridge;
    if (typeof EventSource === 'undefined') {
      setLive('polling');
      const stop = bridge.startPolling();
      liveHandle.set({ close: stop, reconnect: () => bridge.resync() });
      return stop;
    }
    const handle = connectStream({
      url: apiUrl('/stream'),
      onEvent: (e) => {
        markEvent(Date.now());
        bridge.apply(e);
      },
      onOpen: () => bridge.resync(),
      onStatus: setLive,
      onExpired: () => void qc.invalidateQueries({ queryKey: qk.me }),
      checkSession: () =>
        unwrap(api.GET('/auth/me')).then(
          () => 'ok' as const,
          (e: unknown) => (e instanceof ApiError && e.status === 401 ? ('expired' as const) : ('ok' as const)),
        ),
    });
    liveHandle.set(handle);
    return () => handle.close();
  }, [qc, setLive, markEvent]);

  useEffect(() => {
    bridgeRef.current?.setPaused(paused);
  }, [paused]);

  return null;
}
