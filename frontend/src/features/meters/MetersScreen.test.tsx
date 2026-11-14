import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAnnouncements, resetAnnouncer } from '@/lib/a11y/announcer';
import { apiUrl } from '@/lib/api/base';
import { makeQueryClient } from '@/lib/api/query-client';
import { qk } from '@/lib/api/query-keys';
import type { Role } from '@/lib/api/types';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession, toMe } from '@/mocks/session';
import { useAppStore } from '@/stores/app-store';
import { MetersScreen } from './MetersScreen';

const server = setupServer();
let base: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  base = await buildHandlers(['auth', 'monitoring', 'meters', 'demo']);
  server.resetHandlers(...base);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  scenario.reset();
  resetAnnouncer();
  useAppStore.setState({ livePaused: false });
});
afterEach(() => {
  server.resetHandlers(...base);
  scenario.stop();
});

function renderAs(role: Role) {
  const session = startSession(SEED_USERS.find((u) => u.role === role)!);
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(qk.me, toMe(session));
  return render(
    <QueryClientProvider client={client}>
      <MetersScreen />
    </QueryClientProvider>,
  );
}

const counters = { received: 1_284_532, unique: 1_259_345, duplicatesRejected: 25_187, lost: 0, ratePerS: 10, byZone: [{ zone: 'muntenia', received: 600_000, ratePerS: 5 }], at: '2026-11-14T19:00:00.000Z' };

describe('MetersScreen', () => {
  it('keeps the counters out of any live region', async () => {
    renderAs('dispecerat');
    const box = await screen.findByTestId('meter-counters');
    expect(await within(box).findByText('primite')).toBeInTheDocument();
    expect(box.closest('[aria-live],[role="status"],[role="alert"],[role="log"]')).toBeNull();
    expect(box.querySelector('[aria-live],[role="status"],[role="alert"],[role="log"]')).toBeNull();
  });

  it('"Citește rezumatul" announces the received and lost counts', async () => {
    server.use(http.get(apiUrl('/meters/counters'), () => HttpResponse.json(counters)));
    const user = userEvent.setup();
    renderAs('dispecerat');
    await within(await screen.findByTestId('meter-counters')).findByText('1 284 532');
    await user.click(screen.getByRole('button', { name: 'Citește rezumatul' }));
    expect(getAnnouncements().polite.text).toBe('1 284 532 primite, 0 pierdute');
  });

  it('shows the simulator control to the admin only', async () => {
    const first = renderAs('dispecerat');
    await screen.findByTestId('meter-counters');
    expect(screen.queryByRole('button', { name: 'Ritm de vârf' })).toBeNull();
    first.unmount();
    renderAs('admin');
    expect(await screen.findByRole('button', { name: 'Ritm de vârf' })).toBeInTheDocument();
  });

  it('links the recent readings to their file detail', async () => {
    renderAs('dispecerat');
    const table = await screen.findByRole('table', { name: 'Ultimele citiri primite, cele mai noi primele' });
    const links = within(table).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', expect.stringMatching(/^\/files\/[0-9a-f-]{36}$/));
  });

  it('is forbidden for a role without meters', () => {
    renderAs('racordari');
    expect(screen.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
  });
});
