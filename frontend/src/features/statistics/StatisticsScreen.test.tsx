import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/lib/api/types';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import type { Period } from './contract';
import { StatisticsScreen } from './StatisticsScreen';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/statistics',
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => nav.search,
}));

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'statistics'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());

const NORMAL_12 = 'p-2026-11-12-normal';
const STORM_14 = 'p-2026-11-14-storm';
const normal13: Period = {
  id: 'p-normal-13', label: 'Zi normală · 13 nov', kind: 'normal', origin: 'simulator', start: '2026-11-12T22:00:00.000Z', end: '2026-11-13T21:59:59.000Z',
};

const signIn = (role: Role) => startSession(SEED_USERS.find((u) => u.role === role)!);

beforeEach(() => {
  db.reset();
  nav.replace.mockClear();
  nav.search = new URLSearchParams();
});

describe('StatisticsScreen', () => {
  it('answers S1 and S2 for the auditor, comparing the last normal day with the most recent peak', async () => {
    signIn('auditor');
    renderWithClient(<StatisticsScreen />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Ce ne spun datele' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Perioada A')).toHaveDisplayValue('Zi normală · 12 nov');
    expect(screen.getByLabelText('Perioada B')).toHaveDisplayValue('Furtună · 14 nov 15:33');
    expect(screen.getByRole('heading', { level: 2, name: 'Ce storage se potrivește fiecărei categorii?' })).toBeInTheDocument();
    expect(await screen.findAllByText('Recomandat: S3')).toHaveLength(2);
    // S2 compares the preselected pair.
    expect(screen.getByRole('heading', { level: 2, name: 'Zi normală vs. zi de vârf' })).toBeInTheDocument();
    expect(await screen.findByText('Perioada A: Zi normală · 12 nov')).toBeInTheDocument();
    expect(screen.getByText('Perioada B: Furtună · 14 nov 15:33')).toBeInTheDocument();
  });

  it('reads the periods from the URL, ignores an unknown one and writes a new choice back', async () => {
    const user = userEvent.setup();
    db.insert('periods', normal13);
    nav.search = new URLSearchParams(`periodA=${NORMAL_12}&periodB=p-gone`);
    signIn('auditor');
    renderWithClient(<StatisticsScreen />);
    const a = await screen.findByLabelText('Perioada A');
    expect(a).toHaveDisplayValue('Zi normală · 12 nov');
    expect(screen.getByLabelText('Perioada B')).toHaveDisplayValue('Furtună · 14 nov 15:33');

    await user.selectOptions(a, 'Zi normală · 13 nov');
    expect(nav.replace).toHaveBeenCalledWith(`/statistics?periodA=p-normal-13&periodB=${STORM_14}`, { scroll: false });
  });

  it('refetches the statistics on "Actualizează", so a period recorded meanwhile is offered', async () => {
    const user = userEvent.setup();
    signIn('auditor');
    renderWithClient(<StatisticsScreen />);
    const a = await screen.findByLabelText('Perioada A');
    expect(screen.queryByRole('option', { name: 'Zi normală · 13 nov' })).toBeNull();

    db.insert('periods', normal13);
    await user.click(screen.getByRole('button', { name: 'Actualizează' }));
    expect(await screen.findAllByRole('option', { name: 'Zi normală · 13 nov' })).toHaveLength(2);
    // No period in the URL: A follows the newest normal day.
    expect(a).toHaveDisplayValue('Zi normală · 13 nov');
  });

  it('shows the permission state to a role without view_statistics and asks for no statistics', async () => {
    const paths: string[] = [];
    const track = ({ request }: { request: Request }) => void paths.push(new URL(request.url).pathname);
    server.events.on('request:start', track);
    signIn('teren');
    renderWithClient(<StatisticsScreen />);
    expect(await screen.findByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ce ne spun datele' })).toBeNull();
    server.events.removeListener('request:start', track);
    expect(paths.some((p) => p.includes('/auth/me'))).toBe(true);
    expect(paths.filter((p) => p.includes('/statistics'))).toEqual([]);
  });
});
