import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAnnouncements, resetAnnouncer } from '@/lib/a11y/announcer';
import { apiUrl } from '@/lib/api/base';
import { qk } from '@/lib/api/query-keys';
import type { Role } from '@/lib/api/types';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { toStorageHealth } from './queries';
import { StorageHealthStrip } from './StorageHealthStrip';

const NBSP = ' ';

const server = setupServer();
let base: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  base = await buildHandlers(['auth', 'monitoring']);
  server.resetHandlers(...base);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());

const login = (role: Role) => startSession(SEED_USERS.find((u) => u.role === role)!);

beforeEach(() => {
  db.reset();
  scenario.reset();
  resetAnnouncer();
  login('admin');
});
afterEach(() => {
  server.resetHandlers(...base);
  scenario.stop();
});

const items = () => within(screen.getByRole('list', { name: 'Stare storage' })).getAllByRole('listitem');
const item = (name: string) => items().find((li) => li.querySelector('[data-storage-name]')?.textContent === name)!;
/** Rendered once GET /storage-health has answered (every chip has left the "se verifică" state). */
const loaded = () => waitFor(() => expect(items().every((li) => li.getAttribute('data-status') !== 'pending')).toBe(true));

describe('StorageHealthStrip', () => {
  it('shows Postgres · S3 · FTP, each with an icon, its state word and the probe latency', async () => {
    renderWithClient(<StorageHealthStrip />);
    await loaded();
    expect(items().map((li) => li.querySelector('[data-storage-name]')?.textContent)).toEqual(['Postgres', 'S3', 'FTP']);
    for (const li of items()) {
      expect(li).toHaveAttribute('data-status', 'ok');
      expect(li.textContent).toMatch(new RegExp(`^(Postgres|S3|FTP) OK \\d+${NBSP}ms$`));
      expect(li.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(li.querySelector('[data-tone]')?.className).toContain('rounded-chip');
    }
  });

  it('links every chip to Observabilitate for a role that can open it, and to nothing otherwise', async () => {
    const { unmount } = renderWithClient(<StorageHealthStrip />);
    await loaded();
    await waitFor(() => expect(within(item('S3')).getByRole('link')).toHaveAttribute('href', '/observability'));
    expect(within(item('Postgres')).getByRole('link', { name: /^Postgres OK/ })).toHaveAttribute('href', '/observability');
    unmount();

    login('dispecerat');
    const { client } = renderWithClient(<StorageHealthStrip />);
    await loaded();
    await waitFor(() => expect(client.getQueryData(qk.me)).toMatchObject({ activeRole: 'dispecerat' }));
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(item('S3').textContent).toMatch(new RegExp(`^S3 OK \\d+${NBSP}ms$`));
  });

  it('shows an "S3 căzut" chip with its icon, and no latency, when S3 goes down', async () => {
    const { client } = renderWithClient(<StorageHealthStrip />);
    await loaded();
    scenario.setStorage('s3', false);
    // What the live bridge does with a storage.health event.
    act(() => void client.setQueryData(qk.health, { data: scenario.storageHealth() }));
    await waitFor(() => expect(item('S3')).toHaveAttribute('data-status', 'down'));
    expect(item('S3').textContent).toBe('S3 căzut');
    const chip = item('S3').querySelector('[data-tone]');
    expect(chip).toHaveAttribute('data-tone', 'crit');
    expect(chip?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(item('Postgres')).toHaveAttribute('data-status', 'ok');
    expect(item('FTP')).toHaveAttribute('data-status', 'ok');
  });

  it('says "degradat" for a degraded storage and "necunoscut" for one the server did not report', async () => {
    server.use(
      http.get(apiUrl('/storage-health'), () =>
        HttpResponse.json({ data: [{ storage: 'ftp', status: 'degraded', latencyMs: 812, lastCheckAt: new Date().toISOString(), circuitState: 'half_open' }] }),
      ),
    );
    renderWithClient(<StorageHealthStrip />);
    await loaded();
    expect(item('FTP').textContent).toBe(`FTP degradat 812${NBSP}ms`);
    expect(item('FTP').querySelector('[data-tone]')).toHaveAttribute('data-tone', 'warn');
    expect(item('Postgres').textContent).toBe('Postgres necunoscut');
    expect(item('Postgres').querySelector('[data-tone]')).toHaveAttribute('data-tone', 'neutral');
  });

  it('announces a storage going down assertively and its recovery politely, never on mount', async () => {
    const { client } = renderWithClient(<StorageHealthStrip />);
    await loaded();
    expect(getAnnouncements().polite.count + getAnnouncements().assertive.count).toBe(0);

    scenario.setStorage('s3', false);
    act(() => void client.setQueryData(qk.health, { data: scenario.storageHealth() }));
    await waitFor(() => expect(getAnnouncements().assertive.text).toBe('S3: căzut.'));

    scenario.setStorage('s3', true);
    act(() => void client.setQueryData(qk.health, { data: scenario.storageHealth() }));
    await waitFor(() => expect(getAnnouncements().polite.text).toBe('S3: din nou OK.'));
    expect(getAnnouncements().assertive.count).toBe(1);
  });
});

describe('toStorageHealth', () => {
  it('keeps the real contract, maps the proposal labels, drops what it cannot trust', () => {
    const at = '2026-11-14T13:33:00.000Z';
    const parsed = toStorageHealth({
      data: [
        { storage: 'S3', status: 'down', latencyMs: null, lastCheckAt: at, circuitState: 'open' },
        { storage: 'db', status: 'ok', latencyMs: 3, lastCheckAt: at, circuitState: 'closed' },
        { storage: 'tape', status: 'ok', latencyMs: 1, lastCheckAt: at, circuitState: 'closed' },
        { storage: 'ftp', status: 'on_fire', latencyMs: 1, lastCheckAt: at, circuitState: 'closed' },
        null,
      ],
    });
    expect(parsed).toEqual([
      { storage: 'db', status: 'ok', latencyMs: 3, lastCheckAt: at, circuitState: 'closed' },
      { storage: 's3', status: 'down', latencyMs: null, lastCheckAt: at, circuitState: 'open' },
    ]);
    expect(toStorageHealth(undefined)).toEqual([]);
  });
});
