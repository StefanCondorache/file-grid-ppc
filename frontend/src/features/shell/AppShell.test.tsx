import { screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Role } from '@/lib/api/types';
import { FALLBACK_MATRIX } from '@/lib/auth/capabilities';
import { setUploadControl } from '@/lib/upload/engine-port';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { AppShell } from './AppShell';
import { AuthGate } from './AuthGate';

vi.mock('next/navigation', () => ({
  usePathname: () => '/files',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const meFor = (role: Role, demoMode = true, realRole: Role = role): Me => ({
  user: { id: `u-${role}`, username: role, displayName: role, role },
  realUser: { id: `u-${realRole}`, username: realRole, displayName: realRole, role: realRole },
  activeRole: role, roles: [realRole], capabilities: FALLBACK_MATRIX[role], demoMode,
  actingRoleExpiresAt: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), serverTime: new Date().toISOString(),
});

describe('AppShell', () => {
  it('hides Politici and Cameră de control for teren', () => {
    renderWithClient(<AppShell me={meFor('teren')}>x</AppShell>);
    expect(screen.queryByRole('link', { name: /Politici/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Cameră de control/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Încărcare/ })).toBeInTheDocument();
  });

  it('marks the current page with aria-current', () => {
    renderWithClient(<AppShell me={meFor('admin')}>x</AppShell>);
    expect(screen.getByRole('link', { name: /^Fișiere/ })).toHaveAttribute('aria-current', 'page');
  });

  it('renders the exact footer text and a skip link to main', () => {
    renderWithClient(<AppShell me={meFor('admin')}>x</AppShell>);
    expect(screen.getByText('© 2026 FileGrid')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sari la conținut' })).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).not.toBeNull();
  });

  it('shows "Rol activ: Auditor"', () => {
    renderWithClient(<AppShell me={meFor('auditor')}>x</AppShell>);
    expect(screen.getByText('Rol activ: Auditor')).toBeInTheDocument();
  });

  it('shows no demo-only nav or badge when demoMode is false (FE-14)', () => {
    renderWithClient(<AppShell me={meFor('admin', false)}>x</AppShell>);
    expect(screen.queryByRole('link', { name: /Cameră de control/ })).toBeNull();
    expect(screen.queryByText(/Demo · VPS/i)).toBeNull();
  });
});

describe('AuthGate', () => {
  const server = setupServer();
  beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'demo']))); server.listen({ onUnhandledRequest: 'bypass' }); });
  afterAll(() => server.close());
  beforeEach(() => db.reset());

  it('restores uploads for the real user after login', async () => {
    startSession(SEED_USERS.find((u) => u.username === 'admin')!);
    const restoreAndResume = vi.fn(async () => {});
    setUploadControl({ pauseAll: vi.fn(), resumeAll: vi.fn(), restoreAndResume });
    renderWithClient(<AuthGate>conținut</AuthGate>);
    expect(await screen.findByText('conținut')).toBeInTheDocument();
    await waitFor(() => expect(restoreAndResume).toHaveBeenCalledWith('u-admin'));
  });
});
