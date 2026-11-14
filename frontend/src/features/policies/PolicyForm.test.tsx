import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, unwrap } from '@/lib/api/client';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { renderWithClient } from '@/test/render';
import { PolicyScreen } from './PolicyScreen';

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'policies'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => db.reset());

const login = (username: string) => unwrap(api.POST('/auth/login', { body: { username, password: SEED_PASSWORD } }));

async function moveFaultsToFtp() {
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Storage principal'), 'ftp');
  await user.selectOptions(screen.getByLabelText('Storage de rezervă'), 's3');
  await user.click(screen.getByRole('button', { name: 'Revizuiește modificările' }));
  return user;
}

describe('PolicyScreen', () => {
  it('gives the auditor a read-only view', async () => {
    await login('auditor');
    renderWithClient(<PolicyScreen category="fault_records" />);
    expect(await screen.findByText('Doar vizualizare: numai administratorul poate modifica politicile.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revizuiește modificările' })).not.toBeInTheDocument();
  });

  it('admin: diff, confirm, saved as v4', async () => {
    await login('admin');
    renderWithClient(<PolicyScreen category="fault_records" />);
    expect(await screen.findByText('Încărcările în curs păstrează politica de la pornire.')).toBeInTheDocument();
    const user = await moveFaultsToFtp();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('row', { name: /Storage principal S3 FTP/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmă și salvează' }));
    expect(await screen.findByText('Salvat · versiunea v4')).toBeInTheDocument();
  });

  it('409: shows the other change, then re-applies on top of it', async () => {
    await login('admin');
    renderWithClient(<PolicyScreen category="fault_records" />);
    await screen.findByLabelText('Storage principal');
    // Another admin saves v4 (parallelism 2 → 3) while this form still holds v3.
    db.policies.put({ ...db.policies.get('fault')!, version: 4, maxParallel: 3 });
    const user = await moveFaultsToFtp();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirmă și salvează' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Altcineva a salvat versiunea v4 între timp');
    expect(within(notice).getByRole('row', { name: /Părți în paralel 2 3/ })).toBeInTheDocument();
    await user.click(within(notice).getByRole('button', { name: 'Aplică modificările mele peste v4' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirmă și salvează' }));
    expect(await screen.findByText('Salvat · versiunea v5')).toBeInTheDocument();
  });
});
