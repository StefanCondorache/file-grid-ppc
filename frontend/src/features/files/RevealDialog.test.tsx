import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { SEED_IDS, SEED_PII } from '@/mocks/seed/files';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { RevealDialog } from './RevealDialog';

const login = (username: string) => startSession(SEED_USERS.find((u) => u.username === username)!);
const FILE = SEED_IDS.connectionRequest;
const CLEAR = SEED_PII[FILE];
const REASON = 'Control intern GDPR nr. 42';

describe('RevealDialog (FE-13)', () => {
  const server = setupServer();
  let reveals = 0;
  beforeAll(async () => {
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/reveal')) reveals += 1;
    });
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => {
    server.resetHandlers();
    vi.useRealTimers();
  });
  beforeEach(() => {
    db.reset();
    reveals = 0;
    document.title = 'Detaliu fișier · FileGrid';
  });

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    // Disabled until /auth/me says the active role may reveal; the enabled button is a new element.
    const button = await waitFor(() => {
      const b = screen.getByRole('button', { name: 'Afișează datele personale' });
      expect(b).toBeEnabled();
      return b;
    });
    await user.click(button);
    return screen.findByRole('dialog', { name: 'Afișează datele personale' });
  }

  it('blocks a reason shorter than 10 characters with a message, without asking the server', async () => {
    login('auditor');
    const user = userEvent.setup();
    renderWithClient(<RevealDialog fileId={FILE} />);
    await openDialog(user);

    await user.type(screen.getByLabelText('Motivul afișării'), 'scurt');
    await user.click(screen.getByRole('button', { name: 'Afișează' }));
    expect(await screen.findByText('Scrie un motiv de cel puțin 10 caractere.')).toBeInTheDocument();
    expect(screen.getByLabelText('Motivul afișării')).toHaveAttribute('aria-invalid', 'true');
    expect(reveals).toBe(0);
  });

  it('shows the values after the reveal, warns at 15 s with "Prelungește", and hides them at 60 s; never in the title or URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    login('auditor');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithClient(<RevealDialog fileId={FILE} />);
    await openDialog(user);

    await user.type(screen.getByLabelText('Motivul afișării'), REASON);
    await user.click(screen.getByRole('button', { name: 'Afișează' }));
    expect(await screen.findByText(CLEAR.applicantName)).toBeInTheDocument();
    expect(screen.getByText(CLEAR.cnp)).toBeInTheDocument();
    expect(reveals).toBe(1);
    expect(document.title).not.toContain(CLEAR.applicantName);
    expect(document.title).not.toContain(CLEAR.cnp);
    expect(window.location.href).not.toContain(CLEAR.cnp);
    expect(window.location.href).not.toContain(encodeURIComponent(CLEAR.applicantName));
    expect(screen.queryByRole('button', { name: 'Prelungește' })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    expect(screen.getByText('Afișarea se ascunde în 15 s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prelungește' })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.queryByText(CLEAR.applicantName)).toBeNull();
    expect(screen.queryByText(CLEAR.cnp)).toBeNull();
    expect(screen.getByRole('button', { name: 'Afișează datele personale' })).toBeInTheDocument();
  });

  it('"Prelungește" reveals again (audited again) and restarts the 60 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    login('auditor');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithClient(<RevealDialog fileId={FILE} />);
    await openDialog(user);
    await user.type(screen.getByLabelText('Motivul afișării'), REASON);
    await user.click(screen.getByRole('button', { name: 'Afișează' }));
    await screen.findByText(CLEAR.applicantName);

    await act(async () => {
      vi.advanceTimersByTime(50_000);
    });
    await user.click(screen.getByRole('button', { name: 'Prelungește' }));
    await waitFor(() => expect(reveals).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Prelungește' })).toBeNull());
    expect(screen.getByText(CLEAR.applicantName)).toBeInTheDocument();
  });

  it('is disabled with the reason why for racordari', async () => {
    login('racordari');
    const { client } = renderWithClient(<RevealDialog fileId={FILE} />);
    await waitFor(() => expect(client.getQueryData(['auth', 'me'])).toBeTruthy());
    const button = screen.getByRole('button', { name: 'Afișează datele personale' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Doar auditorul poate afișa datele personale.');
    expect(button.parentElement).toHaveAttribute('title', 'Doar auditorul poate afișa datele personale.');
  });
});
