import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/lib/api/query-client';
import { qk } from '@/lib/api/query-keys';
import type { Role } from '@/lib/api/types';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession, toMe } from '@/mocks/session';
import { ObservabilityScreen } from './ObservabilityScreen';

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/observability',
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

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
  nav.search = '';
  nav.replace.mockReset();
});
afterEach(() => {
  server.events.removeAllListeners();
  server.resetHandlers(...base);
  scenario.stop();
});

/** Renders the screen as the given role, with `me` already in the cache, as AuthGate leaves it before any screen. */
function renderAs(role: Role) {
  const session = startSession(SEED_USERS.find((u) => u.role === role)!);
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(qk.me, toMe(session));
  return render(
    <QueryClientProvider client={client}>
      <ObservabilityScreen />
    </QueryClientProvider>,
  );
}

describe('ObservabilityScreen', () => {
  it('reads the window from the URL and writes the chosen one back to it', async () => {
    nav.search = 'window=24h';
    renderAs('auditor');
    expect(screen.getByRole('heading', { level: 2, name: 'Categorie × storage' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: /ultimele 24 de ore$/ })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Interval' });
    expect(screen.getByRole('radio', { name: '24 de ore' })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: '1 oră' }));
    expect(nav.replace).toHaveBeenCalledWith('/observability?window=1h', { scroll: false });
    expect(group).toContainElement(screen.getByRole('radio', { name: '5 minute' }));
  });

  it('falls back to 5 minutes for a window the server does not offer', async () => {
    nav.search = 'window=forever';
    renderAs('admin');
    expect(await screen.findByRole('table', { name: /ultimele 5 minute$/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 minute' })).toBeChecked();
  });

  it('explains the boundary to a role without Observabilitate instead of asking the server', async () => {
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => asked.push(new URL(request.url).pathname));
    renderAs('dispecerat');
    expect(screen.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Interval' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked.filter((p) => p.endsWith('/metrics/matrix'))).toEqual([]);
  });
});
