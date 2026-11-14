import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileDetailScreen } from '@/features/files/FileDetailScreen';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { SEED_IDS } from '@/mocks/seed/files';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { CustodyTimeline, type CustodyEvent } from './CustodyTimeline';

const login = (username: string) => startSession(SEED_USERS.find((u) => u.username === username)!);
const person = (username: string) => ({ id: username, username, displayName: username, role: null });

describe('CustodyTimeline (FE-06)', () => {
  const server = setupServer();
  beforeAll(async () => {
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());
  beforeEach(() => db.reset());

  it('lists events newest first; pii_revealed shows the actor, "Rol demo" when actingAs, and the reason', async () => {
    login('auditor');
    const fileId = SEED_IDS.connectionActing;
    // Oldest first, as the backend sends it.
    const events: CustodyEvent[] = [
      { id: 's', type: 'stored', at: '2026-11-12T08:00:00.000Z', actor: person('racordari'), actingAs: null, demo: false, storage: 's3', policyVersion: 2, reason: null, traceId: 'trace-up-1' },
      { id: 'd', type: 'downloaded', at: '2026-11-13T08:00:00.000Z', actor: person('racordari'), actingAs: null, demo: false, storage: 's3', policyVersion: 2, reason: null, traceId: null },
      { id: 'r', type: 'pii_revealed', at: '2026-11-14T08:40:00.000Z', actor: person('admin'), actingAs: 'auditor', demo: true, storage: 's3', policyVersion: 2, reason: 'Repetiție demo: verificare dosar', traceId: null },
    ];
    server.use(http.get(apiUrl('/files/:fileId/custody'), () => HttpResponse.json({ data: events })));
    renderWithClient(<CustodyTimeline fileId={fileId} />);

    const list = await screen.findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.dataset.type)).toEqual(['pii_revealed', 'downloaded', 'stored']);

    const reveal = items[0];
    expect(within(reveal).getByText('Date personale afișate')).toBeInTheDocument();
    expect(within(reveal).getByText('admin')).toBeInTheDocument();
    expect(within(reveal).getByText('Rol demo')).toBeInTheDocument();
    expect(within(reveal).getByText('acționând ca Auditor')).toBeInTheDocument();
    expect(within(reveal).getByText('Repetiție demo: verificare dosar')).toBeInTheDocument();
    // No demo role on a plain event; the upload links to its trace.
    expect(within(items[1]).queryByText('Rol demo')).toBeNull();
    expect(within(items[2]).getByRole('link', { name: 'Trasare' })).toHaveAttribute('href', '/traces/trace-up-1');
  });

  it('is shown in the file detail from the real custody endpoint shape', async () => {
    login('auditor');
    renderWithClient(<FileDetailScreen fileId={SEED_IDS.connectionRequest} />);
    const panel = await screen.findByRole('region', { name: 'Lanțul de custodie' });
    const items = await within(panel).findAllByRole('listitem');
    expect(items.length).toBeGreaterThan(1);
    expect(within(panel).getByText('Control intern GDPR: verificarea identității solicitantului')).toBeInTheDocument();
  });
});
