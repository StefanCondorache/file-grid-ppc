import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ControlRoom } from './ControlRoom';

vi.mock('next/navigation', () => ({
  usePathname: () => '/demo',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: 720, height: 280 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const FILE_ID = '11111111-2222-4333-8444-555555555555';
const files = http.get(apiUrl('/files'), () =>
  HttpResponse.json({
    data: [{ id: FILE_ID, displayName: 'Avarie PT-12.pdf', category: 'fault_records', size: 2048, storage: 's3', integrity: 'verified' }],
    meta: { page: 1, pageSize: 30, total: 1, hasMore: false },
  }),
);

const server = setupServer();
let base: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  base = [files, ...(await buildHandlers(['auth', 'monitoring', 'meters', 'demo']))];
  server.resetHandlers(...base);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
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

function renderAs(role: Role, demoMode = true) {
  const session = startSession(SEED_USERS.find((u) => u.role === role)!);
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(qk.me, { ...toMe(session), demoMode });
  return render(
    <QueryClientProvider client={client}>
      <ControlRoom />
    </QueryClientProvider>,
  );
}

describe('ControlRoom', () => {
  it('is forbidden for a non-admin role and when demo mode is off', () => {
    const first = renderAs('dispecerat');
    expect(screen.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pornește furtuna' })).toBeNull();
    first.unmount();
    renderAs('admin', false);
    expect(screen.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
  });

  it('opens an in-page confirmation with focus on "Anulează" for every action', async () => {
    const user = userEvent.setup();
    renderAs('admin');
    const names = ['Pornește furtuna', 'Oprește furtuna', 'Oprește S3', 'Pornește S3', 'Oprește FTP', 'Pornește FTP', 'Corupe fișierul', 'Ritm normal', 'Ritm de vârf', 'Resetează demo-ul'];
    await screen.findByRole('option', { name: /Avarie PT-12\.pdf/ });
    for (const name of names) {
      await user.click(screen.getByRole('button', { name }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: 'Anulează' })).toHaveFocus();
      await user.click(within(dialog).getByRole('button', { name: 'Anulează' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    }
  });

  it('starts a storm on the real endpoint after confirmation and reports the result', async () => {
    const user = userEvent.setup();
    renderAs('admin');
    await user.click(await screen.findByRole('button', { name: 'Pornește furtuna' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Pornește furtuna' }));
    expect(await within(screen.getByTestId('action-log')).findByText(/Furtună pornită/)).toBeInTheDocument();
    expect(scenario.storms().map((s) => s.category)).toEqual(['meter_readings']);
    expect(db.list<{ action: string }>('audit').map((a) => a.action)).toContain('storm_start');
  });

  it('stops S3 and reports a failure in words', async () => {
    const user = userEvent.setup();
    renderAs('admin');
    await user.click(await screen.findByRole('button', { name: 'Oprește S3' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Oprește S3' }));
    expect(await screen.findByText(/S3 oprit \(0 replici\)/)).toBeInTheDocument();
    expect(scenario.storageHealth().find((h) => h.storage === 's3')?.status).toBe('down');

    server.use(http.post(apiUrl('/demo/storages/:storage/:action'), () => HttpResponse.json({ code: 'CHAOS_UNAVAILABLE', message: 'x', traceId: 't' }, { status: 503 })));
    await user.click(screen.getByRole('button', { name: 'Pornește S3' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Pornește S3' }));
    expect(await screen.findByText(/API-ul Kubernetes nu răspunde.*cod CHAOS_UNAVAILABLE/)).toBeInTheDocument();
  });

  it('shows the storm countdown aria-hidden and says it on demand', async () => {
    scenario.startStorm('meter_readings', 10, 72);
    const user = userEvent.setup();
    renderAs('admin');
    const timer = await screen.findByTestId('storm-countdown');
    expect(timer).toHaveAttribute('aria-hidden', 'true');
    expect(timer.textContent).toMatch(/^01:1[12]$/);
    await user.click(screen.getByRole('button', { name: 'Cât a mai rămas?' }));
    expect(getAnnouncements().polite.text).toMatch(/Furtuna se mai desfășoară 1 min 1[12] s\./);
  });

  it('uses crimson-outline pills for danger actions and orange only for "Pornește"', async () => {
    renderAs('admin');
    await screen.findByRole('button', { name: 'Pornește furtuna' });
    for (const name of ['Oprește furtuna', 'Oprește S3', 'Oprește FTP', 'Corupe fișierul']) {
      expect(screen.getByRole('button', { name })).toHaveClass('border-crit');
    }
    const orange = screen.getAllByRole('button').filter((b) => b.classList.contains('bg-primary'));
    expect(orange.length).toBeGreaterThan(0);
    for (const b of orange) expect(b.textContent).toMatch(/^Pornește/);
  });

  it('shows the same-screen effect panel', async () => {
    renderAs('admin');
    const panel = screen.getByTestId('effect-panel');
    expect(within(panel).getByRole('heading', { name: 'Izolare pe categorii (bulkhead)' })).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: 'Stare storage' })).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole('heading', { name: 'Cele 4 garanții, acum' }).closest('section')!.querySelectorAll('li')).toHaveLength(4));
  });
});
