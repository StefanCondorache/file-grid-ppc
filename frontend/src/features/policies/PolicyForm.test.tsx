import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/api/query-keys';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { renderWithClient } from '@/test/render';
import { PolicyForm } from './PolicyForm';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth', 'policies']))); server.listen({ onUnhandledRequest: 'bypass' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

async function mount(username: string) {
  const me = await unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));
  const r = renderWithClient(<PolicyForm category="fault_records" />);
  r.client.setQueryData(qk.me, me);
  await screen.findByText(/versiunea v3/);
  return r;
}

describe('PolicyForm', () => {
  it('is read-only for the auditor', async () => {
    await mount('auditor');
    expect(screen.getByLabelText('Storage principal')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Revizuiește modificările' })).toBeNull();
  });

  it('admin: diff, confirm, saved', async () => {
    const user = userEvent.setup();
    await mount('admin');
    const chunk = screen.getByLabelText('Dimensiunea părții (MiB)');
    await user.clear(chunk);
    await user.type(chunk, '9');
    await user.click(screen.getByRole('button', { name: 'Revizuiește modificările' }));
    expect(await screen.findByText(/Dimensiunea părții/, { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Salvează' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvat · versiunea v4'));
  });

  it('shows the conflict when someone else saved first', async () => {
    const user = userEvent.setup();
    await mount('admin');
    const chunk = screen.getByLabelText('Dimensiunea părții (MiB)');
    await user.clear(chunk);
    await user.type(chunk, '9');
    await user.click(screen.getByRole('button', { name: 'Revizuiește modificările' }));
    // the other admin saves v4 behind our back
    const cur = db.policies.get('fault' as never)!;
    db.policies.put({ ...cur, version: 4 });
    await user.click(await screen.findByRole('button', { name: 'Salvează' }));
    expect(await screen.findByText('Politica a fost modificată de altcineva')).toBeInTheDocument();
  });
});
