import { sse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import { currentSession } from '../session';
import { scenario } from '../scenario';

/** SSE mock of GET /stream; `?mockDrop=1` closes the stream every 30 s to rehearse "Reconectare". */
export function createStreamHandlers() {
  // msw's sse() needs EventSource at construction time (absent in jsdom/Node); browsers always have it.
  if (typeof EventSource === 'undefined') return [];
  return [
  sse(apiUrl('/stream'), ({ client, request }) => {
    if (!currentSession()) {
      client.error();
      return;
    }
    scenario.start();
    client.send({ retry: 3000 } as never);
    const off = scenario.on((e) => client.send({ id: String(e.id), event: e.type, data: JSON.stringify(e.data) } as never));
    const drop = new URL(request.url).searchParams.get('mockDrop') === '1' ? setTimeout(() => client.close(), 30_000) : null;
    request.signal.addEventListener('abort', () => {
      off();
      if (drop) clearTimeout(drop);
    });
  }),
];
}
