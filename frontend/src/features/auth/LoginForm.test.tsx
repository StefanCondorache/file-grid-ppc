import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_PASSWORD } from '@/mocks/seed/auth';
import { setMockSettings } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { LoginForm } from './LoginForm';

const server = setupServer();
let authHandlers: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  authHandlers = await buildHandlers(['auth']);
  server.use(...authHandlers);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => db.reset());
afterEach(() => {
  setMockSettings(null);
  server.events.removeAllListeners();
  server.resetHandlers(...authHandlers); // drop per-test overrides
});

/** The form is disabled until GET /auth/login-options answers. */
async function ready() {
  await waitFor(() => expect(screen.getByLabelText('Rol')).toBeEnabled());
}

async function submit(role: string, password?: string) {
  const user = userEvent.setup();
  await ready();
  await user.selectOptions(screen.getByLabelText('Rol'), role);
  if (password) await user.type(screen.getByLabelText('Parolă'), password);
  await user.click(screen.getByRole('button', { name: 'Intră în cont' }));
}

function captureLoginBodies() {
  const seen = vi.fn();
  server.events.on('request:start', async ({ request }) => {
    if (request.url.endsWith('/auth/login')) seen(await request.clone().json());
  });
  return seen;
}

describe('LoginForm', () => {
  it('lists the five roles in Romanian', () => {
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    const options = within(screen.getByLabelText('Rol')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Echipă de teren', 'Dispecerat', 'Angajat racordări', 'Auditor', 'Administrator']);
  });

  it('submits the chosen role as username', async () => {
    const seen = captureLoginBodies();
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await submit('auditor', SEED_PASSWORD);
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ username: 'auditor', password: SEED_PASSWORD }));
  });

  it('asks for the password when passwordless login is off (the default)', async () => {
    const seen = captureLoginBodies();
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await submit('auditor', '');
    expect(await screen.findByText('Introdu parola.')).toBeInTheDocument();
    expect(screen.getByLabelText('Parolă')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Mod demo: autentificare fără parolă.')).not.toBeInTheDocument();
    expect(seen).not.toHaveBeenCalled();
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

  it('keeps the form disabled until the login options are known', async () => {
    let answer: (passwordless: boolean) => void = () => {};
    const answered = new Promise<boolean>((resolve) => { answer = resolve; });
    server.use(http.get(apiUrl('/auth/login-options'), async () => HttpResponse.json({ passwordless: await answered })));
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    expect(screen.getByLabelText('Rol')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Intră în cont' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Intră în cont' }).closest('form')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByLabelText('Parolă')).not.toBeInTheDocument();
    answer(false);
    await ready();
    expect(screen.getByLabelText('Parolă')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Intră în cont' }).closest('form')).not.toHaveAttribute('aria-busy');
  });

  it('falls back to the password form after one quick retry when the login options cannot be read', async () => {
    const attempts = vi.fn();
    server.use(http.get(apiUrl('/auth/login-options'), () => { attempts(); return Response.error(); }));
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Rol')).toBeEnabled(), { timeout: 3_000 });
    expect(screen.getByLabelText('Parolă')).toBeInTheDocument();
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it('asks for the password again when passwordless login is turned off after the page loaded', async () => {
    setMockSettings({ passwordless: true });
    const seen = captureLoginBodies();
    const onLoggedIn = vi.fn();
    renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={onLoggedIn} />);
    await screen.findByText('Mod demo: autentificare fără parolă.');
    setMockSettings(null); // the backend switch goes back to "false"
    await submit('auditor');
    expect(await screen.findByRole('alert')).toHaveTextContent('Unele câmpuri nu sunt completate corect.');
    expect(await screen.findByLabelText('Parolă')).toBeEnabled();
    expect(screen.queryByText('Mod demo: autentificare fără parolă.')).not.toBeInTheDocument();
    await submit('auditor', SEED_PASSWORD);
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('/'));
    expect(seen.mock.calls.map(([body]) => body)).toEqual([{ username: 'auditor' }, { username: 'auditor', password: SEED_PASSWORD }]);
  });

  describe('passwordless demo login', () => {
    beforeEach(() => setMockSettings({ passwordless: true }));

    it('shows only the role dropdown, with the demo note', async () => {
      renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
      expect(await screen.findByText('Mod demo: autentificare fără parolă.')).toBeInTheDocument();
      await ready();
      expect(screen.queryByLabelText('Parolă')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Rol')).toHaveAccessibleDescription('Mod demo: autentificare fără parolă.');
      expect(screen.getByRole('button', { name: 'Intră în cont' })).toBeEnabled();
    });

    it('logs in with the role alone and sends no password', async () => {
      const seen = captureLoginBodies();
      const onLoggedIn = vi.fn();
      renderWithClient(<LoginForm next="/files" reason={null} onLoggedIn={onLoggedIn} />);
      await screen.findByText('Mod demo: autentificare fără parolă.');
      await submit('dispecerat');
      await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('/files'));
      expect(seen).toHaveBeenCalledWith({ username: 'dispecerat' });
    });

    it('keeps the server error state accessible', async () => {
      server.use(http.post(apiUrl('/auth/login'), () => Response.error()));
      renderWithClient(<LoginForm next={null} reason={null} onLoggedIn={() => {}} />);
      await screen.findByText('Mod demo: autentificare fără parolă.');
      await submit('admin');
      expect(await screen.findByRole('alert')).toHaveTextContent('Nu ne putem conecta la server');
    });
  });
});
