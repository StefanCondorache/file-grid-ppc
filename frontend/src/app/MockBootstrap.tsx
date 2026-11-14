'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { setApiFetch } from '@/lib/api/client';
import { mockConfig } from '@/lib/config/mocks';

async function unregisterServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
}

/** Starts mocks before children render (full: service worker; hybrid: in-page), or clears stray workers. */
export function MockBootstrap({ children }: { children: ReactNode }) {
  const config = mockConfig();
  const [ready, setReady] = useState(config.mode === 'off');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (config.mode === 'full') {
        const { startWorker } = await import('@/mocks/browser');
        await startWorker('all');
      } else {
        await unregisterServiceWorkers();
        if (config.mode === 'hybrid' && config.groups !== 'all') {
          const [{ buildHandlers }, { createMockFetch }] = await Promise.all([import('@/mocks/handlers'), import('@/mocks/in-page')]);
          setApiFetch(createMockFetch(await buildHandlers(config.groups)));
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [config.mode, config.groups]);

  return ready ? children : null;
}
