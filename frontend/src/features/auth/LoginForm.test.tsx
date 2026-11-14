import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { renderWithClient } from '@/test/render';
import { LoginForm } from './LoginForm';

const server = setupServer();
beforeAll(async () => { server.use(...(await buildHandlers(['auth']))); server.listen({ onUnhandledRequest: 'error' }); });
afterAll(() => server.close());
beforeEach(() => db.reset());

async function submit(role: string, password: string) {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Rol'), role);
  await user.type(screen.getByLabelText('Parolă'), password);
  await user.click(screen.getByRole('button', { name: 'Intră în cont' }));
}

describe('LoginForm', () => {
  it('lists the five roles in Romanian', () => {
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    const options = within(screen.getByLabelText('Rol')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Echipă de teren', 'Dispecerat', 'Angajat racordări', 'Auditor', 'Administrator']);
  });

  it('submits the chosen role as username', async () => {
    const seen = vi.fn();
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/auth/login')) seen(await request.clone().json());
    });
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await submit('auditor', SEED_PASSWORD);
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ username: 'auditor', password: SEED_PASSWORD }));
    server.events.removeAllListeners();
  });

  it('shows one generic error, never which field', async () => {
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await submit('auditor', 'gresit');
    expect(await screen.findByText('Rol sau parolă greșită.')).toBeInTheDocument();
    expect(screen.getByLabelText('Parolă')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('redirects to safeNext(next) after login', async () => {
    const onLoggedIn = vi.fn();
    renderWithClient(<LoginForm next="//evil.example" reason={null} onLoggedIn={onLoggedIn} />);
    await submit('admin', SEED_PASSWORD);
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('/'));
  });

  it('shows the expired notice when reason=expired', () => {
    renderWithClient(<LoginForm next="/files" reason="expired" onLoggedIn={() => {}} />);
    expect(screen.getByText('Sesiunea a expirat. Intră din nou în cont.')).toBeInTheDocument();
  });

  it('keeps the server error state accessible', async () => {
    server.use(http.post(apiUrl('/auth/login'), () => Response.error()));
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await submit('admin', SEED_PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nu ne putem conecta la server');
  });
});
