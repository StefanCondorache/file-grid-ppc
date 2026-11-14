import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiryDialog } from '@/features/auth/SessionExpiryDialog';
import { AuthGate } from '@/features/shell/AuthGate';
import { ApiError } from '@/lib/api/errors';
import { makeQueryClient } from '@/lib/api/query-client';
import { qk } from '@/lib/api/query-keys';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { endSession, startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { safeNext } from './safe-next';
import { setSessionEndHandler } from './session-end';

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('final review #2: open redirect', () => {
  it('rejects control characters that URL parsing strips', () => {
    expect(safeNext('/\t/evil.example')).toBe('/');
    expect(safeNext('/\n/evil.example')).toBe('/');
    expect(safeNext('/ /evil.example')).toBe('/');
  });
});

describe('final review #1: every 401 ends the session', () => {
  it('a 401 from any query reaches the session-end handler, a wrong password does not', async () => {
    const onEnd = vi.fn();
    const off = setSessionEndHandler(onEnd);
    const client = makeQueryClient();
    await client.fetchQuery({ queryKey: ['files', 'list', {}], queryFn: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'x')), retry: false }).catch(() => {});
    expect(onEnd).toHaveBeenCalledTimes(1);
    await client.getMutationCache().build(client, { mutationFn: () => Promise.reject(new ApiError(401, 'INVALID_CREDENTIALS', 'x')) }).execute(undefined).catch(() => {});
    expect(onEnd).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('final review #3: the countdown starts from the real remaining time', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('shows 2:00 when it opens two minutes before the deadline, even after a long mount', () => {
    const { rerender } = render(<SessionExpiryDialog open={false} deadline={0} onStay={() => {}} onLogout={() => {}} />);
    act(() => { vi.advanceTimersByTime(30_000); });
    rerender(<SessionExpiryDialog open deadline={Date.now() + 120_000} onStay={() => {}} onLogout={() => {}} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2:00');
  });
});

describe('final review #1 and #5: AuthGate wipes on 401 and on another tab’s logout', () => {
  const server = setupServer();
  beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'demo']))); server.listen({ onUnhandledRequest: 'bypass' }); });
  afterAll(() => server.close());
  beforeEach(() => { db.reset(); replace.mockReset(); });

  it('a 401 from another query wipes the cache and redirects with reason=expired', async () => {
    startSession(SEED_USERS.find((u) => u.username === 'auditor')!);
    const { client } = renderWithClient(<AuthGate>conținut</AuthGate>);
    expect(await screen.findByText('conținut')).toBeInTheDocument();
    client.setQueryData(qk.files.list({}), { data: ['secret'] });
    endSession();
    await client.fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'x')), retry: false }).catch(() => {});
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining('/login?reason=expired')));
    expect(client.getQueryData(qk.files.list({}))).toBeUndefined();
  });

  it('a logout in another tab wipes this tab too', async () => {
    startSession(SEED_USERS.find((u) => u.username === 'auditor')!);
    const { client } = renderWithClient(<AuthGate>conținut</AuthGate>);
    expect(await screen.findByText('conținut')).toBeInTheDocument();
    client.setQueryData(qk.files.list({}), { data: ['secret'] });
    const other = new BroadcastChannel('filegrid-session');
    other.postMessage({ type: 'logout' });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(client.getQueryData(qk.files.list({}))).toBeUndefined();
    other.close();
  });
});

void QueryClient;
