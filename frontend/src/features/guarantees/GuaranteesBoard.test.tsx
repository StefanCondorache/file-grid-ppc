import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { qk } from '@/lib/api/query-keys';
import { CATEGORY_IDS } from '@/lib/monitoring/contract';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { GuaranteesBoard } from './GuaranteesBoard';
import { toGuarantees } from './queries';

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

describe('GuaranteesBoard', () => {
  it('shows the four guarantees from GET /guarantees, in board order, with the meter counters', async () => {
    renderWithClient(<GuaranteesBoard />);
    expect(screen.getByRole('heading', { level: 2, name: 'Cele 4 garanții, acum' })).toBeInTheDocument();
    const cards = await screen.findAllByRole('article');
    expect(cards.map((c) => c.getAttribute('data-category'))).toEqual([...CATEGORY_IDS]);
    expect(cards.map((c) => c.getAttribute('data-state'))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(within(cards[0]!).getByRole('heading', { level: 3, name: 'Citiri contoare' })).toBeInTheDocument();
    expect(within(cards[0]!).getByText('pierdute (trebuie 0)').nextElementSibling?.textContent).toBe('0');
  });

  it('follows the guarantees.status snapshot the live bridge writes to the cache', async () => {
    const { client } = renderWithClient(<GuaranteesBoard />);
    await screen.findAllByRole('article');
    scenario.startStorm('fault_records', 10, 60);
    for (let i = 0; i < 3; i += 1) scenario.tick();
    client.setQueryData(qk.guarantees, { data: scenario.guarantees() });
    const faults = screen.getByRole('article', { name: 'Avarii' });
    await waitFor(() => expect(faults).toHaveAttribute('data-state', 'at_risk'));
    expect(within(faults).getByText('În pericol')).toBeInTheDocument();
    expect(faults.textContent).toMatch(/Avariile ajung la dispecerat în \d+(,\d)?\u00A0s, peste ținta de 2\u00A0s\./);
  });

  it('shows a safe error with a retry when the guarantees cannot be read', async () => {
    server.use(http.get(apiUrl('/guarantees'), () => HttpResponse.json({ code: 'STORAGE_UNAVAILABLE', message: 'x', traceId: 't-1' }, { status: 503 })));
    renderWithClient(<GuaranteesBoard />);
    expect(await screen.findByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });
});

describe('toGuarantees', () => {
  it('keeps the real contract, maps the proposal ids, drops what it cannot trust and sorts in board order', () => {
    const parsed = toGuarantees({
      data: [
        { category: 'drone', state: 'ok', causeCode: null, metrics: [{ key: 'successRate', value: 1, threshold: 0.95 }], updatedAt: 'x' },
        { category: 'fault_records', state: 'at_risk', causeCode: 'FAULT_P95_ABOVE_TARGET', causeFacts: { p95Ms: 3400 }, metrics: 'nope', updatedAt: 'x' },
        { category: 'teleport', state: 'ok', metrics: [] },
        { category: 'meter_readings', state: 'on_fire', metrics: [] },
        null,
      ],
    });
    expect(parsed.map((g) => [g.category, g.state])).toEqual([['fault_records', 'at_risk'], ['drone_videos', 'ok']]);
    expect(parsed[0]).toMatchObject({ causeFacts: { p95Ms: 3400 }, metrics: [] });
    expect(parsed[1]).toMatchObject({ causeFacts: {}, metrics: [{ key: 'successRate', value: '1', threshold: '0.95', unit: null, comparator: null }] });
    expect(toGuarantees(undefined)).toEqual([]);
  });
});
