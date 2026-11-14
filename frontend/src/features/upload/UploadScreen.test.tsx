import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/lib/api/types';
import { uploadEngine } from '@/lib/upload/engine';
import { useUploadStore } from '@/lib/upload/store';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { UploadScreen } from './UploadScreen';

// The URL is the category's only store: a tiny router whose replace() re-renders like Next's does.
const nav = vi.hoisted(() => {
  let search = new URLSearchParams();
  const listeners = new Set<() => void>();
  return {
    get: () => search,
    set(url: string) {
      search = new URL(url, 'http://localhost').searchParams;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePathname: () => '/upload',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.get, nav.get),
    useRouter: () => ({ replace: (url: string) => nav.set(url), push: (url: string) => nav.set(url) }),
  };
});

const server = setupServer();
beforeAll(async () => {
  server.use(...(await buildHandlers(['auth', 'uploads'])));
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  nav.set('/upload');
  useUploadStore.setState({ items: {} });
});
afterEach(() => vi.restoreAllMocks());

function signIn(role: Role) {
  startSession(SEED_USERS.find((u) => u.role === role)!);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('UploadScreen', () => {
  it('refuses a file the policy forbids and queues the others with the metadata', async () => {
    signIn('teren');
    const enqueue = vi.spyOn(uploadEngine, 'enqueue').mockReturnValue('local-1');
    const { container } = renderWithClient(<UploadScreen />);
    const user = userEvent.setup({ applyAccept: false });

    // teren uploads drone videos and fault records, not connection documents (FE-01).
    expect(await screen.findByRole('radio', { name: /Video inspecție dronă/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Înregistrare de avarie/ })).not.toBeChecked();
    expect(screen.queryByRole('radio', { name: /Document de racordare/ })).toBeNull();
    // Where the file goes, from the live policy (seed: drone v3, S3 with FTP fallback, 8 MiB × 4).
    const policy = await screen.findByRole('region', { name: 'Unde ajunge fișierul' });
    expect(within(policy).getByText('S3 (rezervă: FTP)')).toBeInTheDocument();
    expect(within(policy).getByText('8\u00A0MiB · 4 în paralel', { normalizer: (s) => s })).toBeInTheDocument();
    expect(screen.getByText(/MP4, MOV · maximum 4\u00A0GB \(politica v3\)/, { normalizer: (s) => s })).toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const video = new File(['drone bytes'], 'Inspectie_LEA_110kV.mp4', { type: 'video/mp4' });
    const notes = new File(['notes'], 'notite.txt', { type: 'text/plain' });
    await user.upload(input, [notes, video]);

    // Review Focus 5: refused before any request, with the reason in Romanian.
    expect(screen.getByText('Tipul text/plain nu este permis pentru această categorie.')).toBeInTheDocument();
    const chosen = screen.getByRole('list', { name: 'Fișiere alese' });
    expect(within(chosen).getAllByRole('listitem')).toHaveLength(1);
    expect(within(chosen).getByText('Inspectie_LEA_110kV.mp4')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Linie \/ tronson/), 'LEA 110 kV Călărași – Oltenița');
    await user.selectOptions(screen.getByLabelText(/^Zonă/), 'Muntenia');
    await user.click(screen.getByRole('button', { name: 'Încarcă 1 fișier' }));

    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith({
        file: video,
        category: 'drone_videos',
        metadata: { kind: 'drone', lineSection: 'LEA 110 kV Călărași – Oltenița', zone: 'muntenia', inspectionDate: today() },
        handle: null,
      }),
    );
    expect(screen.queryByRole('list', { name: 'Fișiere alese' })).toBeNull();
    // The refusal belonged to that choice: once the batch is queued it goes too.
    expect(screen.queryByText('Tipul text/plain nu este permis pentru această categorie.')).toBeNull();
  });

  it('keeps the category in the URL, limited to what the active role may upload', async () => {
    signIn('racordari');
    nav.set('/upload?category=drone');
    const { unmount } = renderWithClient(<UploadScreen />);
    // racordari may only upload connection documents: a drone link falls back to them.
    expect(await screen.findByRole('radio', { name: /Document de racordare/ })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(await screen.findByLabelText(/^CNP/)).toBeInTheDocument();
    unmount();

    signIn('admin');
    nav.set('/upload');
    renderWithClient(<UploadScreen />);
    const user = userEvent.setup();
    expect(await screen.findAllByRole('radio')).toHaveLength(3);
    await user.click(screen.getByRole('radio', { name: /Înregistrare de avarie/ }));
    expect(nav.get().get('category')).toBe('fault');
    expect(screen.getByRole('radio', { name: /Înregistrare de avarie/ })).toBeChecked();
    expect(await screen.findByLabelText(/^Data și ora avariei/)).toBeInTheDocument();
  });

  it('tells a role without upload rights that it cannot upload', async () => {
    signIn('auditor');
    renderWithClient(<UploadScreen />);
    expect(await screen.findByText('Nu ai acces la această pagină')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
