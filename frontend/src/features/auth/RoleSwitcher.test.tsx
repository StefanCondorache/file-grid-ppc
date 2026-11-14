import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import type { Me } from '@/lib/api/types';
import { liveHandle } from '@/lib/live/registry';
import { setUploadControl } from '@/lib/upload/engine-port';
import { RoleSlot } from '@/features/shell/RoleSlot';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { renderWithClient } from '@/test/render';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'demo']))); server.listen({ onUnhandledRequest: 'bypass' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

async function loginAs(username: string): Promise<Me> {
  return unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
}

describe('RoleSwitcher', () => {
  it('is absent when demo mode is off', async () => {
    const me = { ...(await loginAs('admin')), demoMode: false };
    renderWithClient(<RoleSlot me={me} />);
    expect(screen.getByText('Rol activ: Administrator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rol activ/ })).toBeNull();
  });

  it('offers the five roles as a radio group and switches without touching uploads', async () => {
    const me = await loginAs('admin');
    const control = { pauseAll: vi.fn(), resumeAll: vi.fn(), restoreAndResume: vi.fn(async () => {}) };
    setUploadControl(control);
    const reconnect = vi.fn();
    liveHandle.set({ close: vi.fn(), reconnect });
    const { client } = renderWithClient(<RoleSlot me={me} />);
    client.setQueryData(qk.me, me);
    client.setQueryData(qk.files.list({}), { data: ['x'] });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Rol activ: Administrator/ }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Echipă de teren', 'Dispecerat', 'Angajat racordări', 'Auditor', 'Administrator']);
    expect(items[4]).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('menuitemradio', { name: 'Auditor' }));
    await waitFor(() => expect((client.getQueryData(qk.me) as Me).activeRole).toBe('auditor'));
    expect(client.getQueryData(qk.files.list({}))).toBeUndefined();
    expect(reconnect).toHaveBeenCalled();
    expect(control.pauseAll).not.toHaveBeenCalled();
  });
});
