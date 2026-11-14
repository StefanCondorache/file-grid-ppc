import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { qk } from '@/lib/api/query-keys';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { AlertsList } from './AlertsList';
import { toAlerts } from './queries';

const server = setupServer();
let base: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  base = await buildHandlers(['auth', 'monitoring']);
  server.resetHandlers(...base);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  scenario.reset();
  startSession(SEED_USERS.find((u) => u.role === 'dispecerat')!);
});
afterEach(() => {
  server.resetHandlers(...base);
  scenario.stop();
});

const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const cells = (row: HTMLElement) => within(row).getAllByRole('cell');

function storm() {
  scenario.startStorm('fault_records', 10, 120);
  for (let i = 0; i < 3; i += 1) scenario.tick();
}

describe('AlertsList', () => {
  it('lists the alerts newest first in a table: time, guarantee, state, cause, trace and acknowledgement', async () => {
    storm();
    renderWithClient(<AlertsList />);
    const table = await screen.findByRole('table', { name: 'Alertele garanțiilor, cele mai noi primele' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Ridicată la', 'Garanția', 'Stare', 'Cauza', 'Urmă', 'Confirmare']);
    await waitFor(() => expect(rows(table)).toHaveLength(2));

    const [now, yesterday] = rows(table).map(cells);
    expect(now![1]!.textContent).toBe('Avarii');
    expect(now![2]!.textContent).toBe('În pericol');
    expect(now![3]!.textContent).toMatch(/^Avariile ajung la dispecerat în \d+(,\d)? s, peste ținta de 2 s\.$/);
    expect(now![4]!.textContent).toBe('—');
    expect(within(now![5]!).getByRole('button', { name: 'Confirmă alerta Avarii' })).toBeInTheDocument();

    // The seed: yesterday's storm, resolved and acknowledged by the dispatcher.
    expect(yesterday![0]!.textContent).toMatch(/rezolvată la \d{2}:\d{2}/);
    expect(yesterday![2]!.textContent).toBe('Rezolvată');
    expect(yesterday![2]!.querySelector('[data-tone]')).toHaveAttribute('data-tone', 'ok');
    expect(yesterday![5]!.textContent).toMatch(/^Confirmată de Elena Marin la \d{2}:\d{2}$/);
  });

  it('links the trace of an alert that has one', async () => {
    server.use(
      http.get(apiUrl('/alerts'), () =>
        HttpResponse.json({
          data: [{
            id: '8c1f6c1e-1f7a-4c2d-9a51-7d2c4e8f1a06', category: 'drone_videos', state: 'violated', raisedAt: '2026-11-14T13:33:00.000Z',
            resolvedAt: null, causeCode: 'DRONE_SUCCESS_BELOW_TARGET', causeFacts: { successRate: 0.9, min: 0.95 }, traceId: 'trace-7f3a',
            acknowledgedAt: null, acknowledgedBy: null,
          }],
          meta: { page: 1, pageSize: 50, total: 1, hasMore: false },
        }),
      ),
    );
    renderWithClient(<AlertsList />);
    const table = await screen.findByRole('table');
    const [row] = rows(table);
    expect(within(row!).getByRole('link', { name: 'trace-7f3a' })).toHaveAttribute('href', '/traces/trace-7f3a');
    expect(cells(row!)[2]!.querySelector('[data-tone]')).toHaveAttribute('data-tone', 'crit');
  });

  it('acknowledges from the list too, and the row shows who and when', async () => {
    storm();
    const user = userEvent.setup();
    const { client } = renderWithClient(<AlertsList />);
    const table = await screen.findByRole('table');
    await user.click(await within(table).findByRole('button', { name: 'Confirmă alerta Avarii' }));
    await within(table).findByText(/^Confirmată de Elena Marin la \d{2}:\d{2}$/, { selector: 'tr:first-child *' });
    expect(scenario.alerts('active')[0]?.acknowledgedBy?.username).toBe('dispecerat');
    // The cache (shared with the banner and fed by alert.updated) holds the acknowledged alert.
    const cached = toAlerts(client.getQueryData(qk.alerts));
    expect(cached.find((a) => a.state !== 'resolved')?.acknowledgedBy?.displayName).toBe('Elena Marin');
  });

  it('says so when there is no alert', async () => {
    server.use(http.get(apiUrl('/alerts'), () => HttpResponse.json({ data: [], meta: { page: 1, pageSize: 50, total: 0, hasMore: false } })));
    renderWithClient(<AlertsList />);
    expect(await screen.findByText('Nicio alertă până acum: toate garanțiile au fost respectate.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('toAlerts', () => {
  it('keeps the real contract, maps the proposal ids, drops what it cannot trust', () => {
    const at = '2026-11-14T13:33:00.000Z';
    const parsed = toAlerts({
      data: [
        { id: 'a1', category: 'fault', state: 'at_risk', raisedAt: at, causeCode: 'FAULT_P95_ABOVE_TARGET', causeFacts: { p95Ms: 3400 }, acknowledgedBy: { displayName: 'x' } },
        { id: 'a2', category: 'teleport', state: 'at_risk', raisedAt: at, causeCode: 'X' },
        { id: 'a3', category: 'drone_videos', state: 'on_fire', raisedAt: at, causeCode: 'X' },
        { category: 'drone_videos', state: 'resolved', raisedAt: at, causeCode: 'X' },
        null,
      ],
    });
    expect(parsed).toEqual([
      {
        id: 'a1', category: 'fault_records', state: 'at_risk', raisedAt: at, resolvedAt: null, causeCode: 'FAULT_P95_ABOVE_TARGET',
        causeFacts: { p95Ms: 3400 }, traceId: null, acknowledgedAt: null, acknowledgedBy: null,
      },
    ]);
    expect(toAlerts(undefined)).toEqual([]);
  });
});
