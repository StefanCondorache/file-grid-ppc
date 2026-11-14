import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { FilesScreen } from './FilesScreen';
import { FilesTable } from './FilesTable';
import { IntegrityBadge } from './IntegrityBadge';
import type { FileItem } from './queries';

/**
 * The URL as real state, the way Next integrates the native History API: the screen writes it with
 * `history.replaceState` and reads it back through `useSearchParams()`.
 */
const nav = vi.hoisted(() => {
  let url = '/files';
  let params = new URLSearchParams();
  const listeners = new Set<() => void>();
  return {
    url: () => url,
    params: () => params,
    go(next: string) {
      url = next;
      params = new URLSearchParams(next.split('?')[1] ?? '');
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
});

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePathname: () => '/files',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.params, nav.params),
    useRouter: () => ({ replace: (u: string) => nav.go(u), push: (u: string) => nav.go(u), prefetch: () => {} }),
  };
});

const item = (over: Partial<FileItem> = {}): FileItem => ({
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Avarie_PT_Medgidia_12.pdf',
  category: 'fault_records',
  size: 2_457_600,
  mimeType: 'application/pdf',
  createdAt: '2026-11-14T13:33:12.000Z',
  uploadedBy: { id: 'teren', username: 'teren', displayName: 'teren', role: null },
  zone: 'dobrogea',
  origin: 'manual',
  storage: 's3',
  usedFallback: false,
  integrity: 'verified',
  encryptedAtRest: false,
  policyVersion: 3,
  ...over,
});

const STATUS_COLOUR = /\b(?:bg|text|border)-(?:ok|warn|crit)(?:-tint|-ink)?\b/;

describe('FilesTable', () => {
  it('renders the name through SafeName, the storage tag and the severity as level bars, not a status colour', () => {
    const hostile = '\u202Egnp.exe<img src=x onerror=alert(1)>';
    const { container } = render(
      <FilesTable
        category="fault_records"
        sort="-createdAt"
        onSort={vi.fn()}
        rows={[
          item({ displayName: hostile, metadata: { severity: 'critical', substation: 'PT Tulcea 3' } }),
          item({ id: '00000000-0000-4000-8000-000000000002', displayName: 'Avarie_Buzău_PT_7.pdf', metadata: { severity: 'medium' } }),
        ]}
      />,
    );
    // SafeName (SR-7): no markup, bidi override stripped, direction isolated, linked to the detail.
    expect(container.querySelector('img')).toBeNull();
    const name = screen.getByText('gnp.exe<img src=x onerror=alert(1)>');
    expect(name).toHaveAttribute('dir', 'auto');
    expect(name.closest('a')).toHaveAttribute('href', '/files/00000000-0000-4000-8000-000000000001');

    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first!).getByText('S3')).toBeInTheDocument();
    expect(within(first!).getByText('PT Tulcea 3')).toBeInTheDocument();

    const critical = within(first!).getByText('Critică').closest('[data-level]')!;
    expect(critical).toHaveAttribute('data-level', '4');
    expect(critical.querySelectorAll('[data-bar="on"]')).toHaveLength(4);
    const medium = within(second!).getByText('Medie').closest('[data-level]')!;
    expect(medium.querySelectorAll('[data-bar="on"]')).toHaveLength(2);
    expect(medium.querySelectorAll('[data-bar="off"]')).toHaveLength(2);
    for (const el of [critical, ...critical.querySelectorAll('*')]) expect(el.getAttribute('class') ?? '').not.toMatch(STATUS_COLOUR);
    expect(screen.getByRole('columnheader', { name: /Gravitate/ })).toBeInTheDocument();
  });

  it('leaves out the severity column while the list rows carry no severity (backend ask)', () => {
    render(<FilesTable category="fault_records" sort="-createdAt" onSort={vi.fn()} rows={[item()]} />);
    expect(screen.queryByRole('columnheader', { name: /Gravitate/ })).toBeNull();
  });

  it('marks connection documents "Criptat în repaus"', () => {
    render(
      <FilesTable
        category="connection_documents"
        sort="-createdAt"
        onSort={vi.fn()}
        rows={[item({ category: 'connection_documents', displayName: 'Document racordare RC-2026-0412 (cerere)', storage: 'db', encryptedAtRest: true, zone: 'muntenia' })]}
      />,
    );
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText('Criptat în repaus')).toBeInTheDocument();
    expect(within(row).getByText('DB')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Gravitate/ })).toBeNull();
  });

  it('shows "FTP · rezervă" for a row written to the fallback (FE-08)', () => {
    render(
      <FilesTable
        sort="-createdAt"
        onSort={vi.fn()}
        rows={[item({ storage: 'ftp', usedFallback: true }), item({ id: '00000000-0000-4000-8000-000000000002', storage: 'ftp' })]}
      />,
    );
    const [fallback, primary] = screen.getAllByRole('row').slice(1);
    expect(within(fallback!).getByText('FTP · rezervă')).toBeInTheDocument();
    // "Toate": the category is named under the file name.
    expect(within(fallback!).getByText('Avarie')).toBeInTheDocument();
    expect(within(primary!).getByText('FTP')).toBeInTheDocument();
    expect(within(primary!).queryByText(/rezervă/)).toBeNull();
  });

  it('sorts by size from a header button with aria-sort', () => {
    const onSort = vi.fn();
    const { rerender } = render(<FilesTable sort="-createdAt" onSort={onSort} rows={[item()]} />);
    expect(screen.getByRole('columnheader', { name: /Încărcat/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: /Mărime/ }));
    expect(onSort).toHaveBeenCalledWith('-size');
    rerender(<FilesTable sort="-size" onSort={onSort} rows={[item()]} />);
    expect(screen.getByRole('columnheader', { name: /Mărime/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: /Mărime/ }));
    expect(onSort).toHaveBeenLastCalledWith('size');
  });
});

describe('IntegrityBadge', () => {
  it('names each state with a word and an icon', () => {
    const states = [
      ['verified', 'Verificat'],
      ['server_verified', 'Verificat de server'],
      ['unverified', 'Neverificat'],
      ['corrupt', 'Fișier corupt detectat'],
    ] as const;
    for (const [state, word] of states) {
      const { container, unmount } = render(<IntegrityBadge state={state} />);
      expect(screen.getByText(word)).toBeInTheDocument();
      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(container.firstElementChild?.className).toContain('rounded-chip');
      unmount();
    }
  });
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('FilesScreen', () => {
  const server = setupServer();
  const seen: URL[] = [];
  beforeAll(async () => {
    vi.spyOn(window.history, 'replaceState').mockImplementation((_data, _unused, url) => nav.go(String(url)));
    // Initial handlers, so resetHandlers() after a per-test override keeps them.
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/files')) seen.push(new URL(request.url));
    });
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());
  beforeEach(() => {
    db.reset();
    seen.length = 0;
    nav.go('/files');
    startSession(SEED_USERS.find((u) => u.username === 'admin')!);
  });

  it('shows the empty state for filters that match nothing, and "Resetează filtrele" clears them', async () => {
    nav.go('/files?q=niciun-rezultat');
    renderWithClient(<FilesScreen />);
    const heading = await screen.findByRole('heading', { name: 'Niciun fișier pentru aceste filtre' });
    fireEvent.click(within(heading.closest('section')!).getByRole('button', { name: 'Resetează filtrele' }));
    expect(nav.url()).toBe('/files');
    expect(await screen.findByText('Inspecție_post_furtună_Tulcea.mp4')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Caută' })).toHaveValue('');
  });

  it('shows the error with its trace ID, never the raw server text', async () => {
    server.use(
      http.get(apiUrl('/files'), () =>
        HttpResponse.json({ code: 'STORAGE_UNAVAILABLE', message: 'pg: relation files is locked', traceId: 'tr-files-503' }, { status: 503, headers: { 'Retry-After': '5' } }),
      ),
    );
    renderWithClient(<FilesScreen />);
    expect(await screen.findByText('tr-files-503')).toBeInTheDocument();
    expect(screen.getByText('Storage-ul nu este disponibil. Celelalte categorii funcționează normal.')).toBeInTheDocument();
    expect(screen.queryByText(/relation files/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
  });

  it('pages 25 at a time and says "Afișate 1–25 din 128"', async () => {
    server.use(
      http.get(apiUrl('/files'), ({ request }) => {
        const q = new URL(request.url).searchParams;
        const page = Number(q.get('page'));
        const size = Number(q.get('pageSize'));
        const first = (page - 1) * size;
        const data = Array.from({ length: Math.max(0, Math.min(size, 128 - first)) }, (_, i) => item({ id: uuid(first + i + 1), displayName: `Avarie_${first + i + 1}.pdf` }));
        return HttpResponse.json({ data, meta: { page, pageSize: size, total: 128, hasMore: first + size < 128 } });
      }),
    );
    renderWithClient(<FilesScreen />);
    expect(await screen.findByText('Afișate 1–25 din 128')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(26);
    expect(screen.getByRole('button', { name: 'Pagina anterioară' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Pagina următoare' }));
    expect(nav.url()).toBe('/files?page=2');
    expect(await screen.findByText('Afișate 26–50 din 128')).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('page')).toBe('2');
    expect(seen.at(-1)?.searchParams.get('pageSize')).toBe('25');
  });

  it('round-trips uploader, integrity, storage and sort by size through the URL', async () => {
    renderWithClient(<FilesScreen />);
    await screen.findByText('Inspecție_post_furtună_Tulcea.mp4');

    fireEvent.change(screen.getByLabelText('Încărcat de'), { target: { value: 'teren' } });
    fireEvent.change(screen.getByLabelText('Integritate'), { target: { value: 'verified' } });
    fireEvent.change(screen.getByLabelText('Storage'), { target: { value: 'ftp' } });
    fireEvent.click(screen.getByRole('button', { name: /Mărime/ }));
    expect(nav.url()).toBe('/files?uploader=teren&integrity=verified&storage=ftp&sort=-size');

    // The screen reads its state back from the URL…
    expect(screen.getByLabelText('Încărcat de')).toHaveValue('teren');
    expect(screen.getByLabelText('Integritate')).toHaveValue('verified');
    expect(screen.getByLabelText('Storage')).toHaveValue('ftp');
    expect(screen.getByRole('columnheader', { name: /Mărime/ })).toHaveAttribute('aria-sort', 'descending');
    // …and lists the one verified fault teren uploaded that sits on FTP: the fallback write.
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText('Defect_celulă_MT_Arad.pdf')).toBeInTheDocument();
    expect(within(row).getByText('FTP · rezervă')).toBeInTheDocument();

    // GET /files gets only the real contract's filters; storage and uploader are narrowed in the browser.
    const last = seen.at(-1)!.searchParams;
    expect(last.get('integrity')).toBe('verified');
    expect(last.get('sort')).toBe('-size');
    expect(last.has('storage')).toBe(false);
    expect(last.has('uploader')).toBe(false);
  });
});
