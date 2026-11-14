import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { formatDateTime } from '@/lib/i18n/format';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { FilesScreen } from './FilesScreen';
import type { MeterReading } from './queries';

/** The URL as real state, read through `useSearchParams()` and written with `history.replaceState` (as in FilesTable.test.tsx). */
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

const NBSP = ' ';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A reading as the real `GET /meter-readings` sends it (backend/src/meters/meters.service.ts `list`). */
const reading = (over: Partial<MeterReading> = {}): MeterReading => ({
  fileId: uuid(31),
  meterId: 'RO-DOB-000042',
  zone: 'dobrogea',
  readingTime: '2026-11-14T13:30:00.000Z',
  kwh: 0.183,
  sequence: 1763127000042,
  receivedAt: '2026-11-14T13:30:02.000Z',
  storage: 'db',
  origin: 'simulator',
  ...over,
});

const TOTAL = 1_284_532;

/** The real list: newest first, `meta.total` counts every reading, so it is only an estimate once filtered. */
function readingsPage(q: URLSearchParams) {
  const page = Number(q.get('page') ?? 1);
  const pageSize = Number(q.get('pageSize') ?? 50);
  const filtered = q.has('zone') || q.has('meterId') || q.has('origin');
  const data = [
    reading(),
    reading({ fileId: uuid(32), meterId: 'RO-MUN-000007', zone: 'muntenia', readingTime: '2026-11-14T13:15:00.000Z', kwh: 12.5, sequence: 1763127000007, storage: 's3', origin: 'storm' }),
    ...Array.from({ length: pageSize - 2 }, (_, i) => reading({ fileId: uuid(40 + i), meterId: `RO-BAN-${String(i + 1).padStart(6, '0')}`, zone: 'banat', sequence: 1763127000100 + i })),
  ];
  return { data, meta: { page, pageSize, total: TOTAL, totalIsEstimate: filtered, hasMore: true } };
}

describe('MeterReadingsTable on /files?category=meter', () => {
  const server = setupServer();
  const readingRequests: URL[] = [];
  const fileListRequests: URL[] = [];
  beforeAll(async () => {
    vi.spyOn(window.history, 'replaceState').mockImplementation((_data, _unused, url) => nav.go(String(url)));
    server.resetHandlers(
      http.get(apiUrl('/meter-readings'), ({ request }) => HttpResponse.json(readingsPage(new URL(request.url).searchParams))),
      ...(await buildHandlers(['auth', 'files'])),
    );
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/meter-readings')) readingRequests.push(url);
      if (url.pathname.endsWith('/files')) fileListRequests.push(url);
    });
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());
  beforeEach(() => {
    db.reset();
    readingRequests.length = 0;
    fileListRequests.length = 0;
    startSession(SEED_USERS.find((u) => u.username === 'dispecerat')!);
  });

  it('renders meter id, zone, reading time, kWh and sequence; the row links to /files/{fileId}', async () => {
    nav.go('/files?category=meter');
    renderWithClient(<FilesScreen />);

    const link = await screen.findByRole('link', { name: 'RO-DOB-000042' });
    expect(link).toHaveAttribute('href', `/files/${uuid(31)}`);
    for (const name of ['Contor', 'Zonă', 'Citită la', 'Consum (kWh)', 'Secvență', 'Storage', 'Origine']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    // The readings table, not the generic files list: no file columns, no GET /files.
    expect(screen.queryByRole('columnheader', { name: /Mărime|Integritate/ })).toBeNull();
    expect(screen.getByRole('table', { name: 'Citiri contoare, cele mai noi primele' })).toBeInTheDocument();
    expect(fileListRequests).toHaveLength(0);

    const first = link.closest('tr')!;
    expect(within(first).getByText('Dobrogea')).toBeInTheDocument();
    const time = within(first).getByText(formatDateTime('2026-11-14T13:30:00.000Z'));
    expect(time.closest('time')).toHaveAttribute('dateTime', '2026-11-14T13:30:00.000Z');
    expect(within(first).getByText('0,183')).toHaveClass('tabular-nums');
    // A sequence is a counter the meter sends, shown as sent (it is part of the reading id), not grouped.
    expect(within(first).getByText('1763127000042')).toBeInTheDocument();
    expect(within(first).getByText('DB')).toBeInTheDocument();
    expect(within(first).getByText('simulator')).toBeInTheDocument();

    const second = screen.getByRole('link', { name: 'RO-MUN-000007' }).closest('tr')!;
    expect(within(second).getByRole('link')).toHaveAttribute('href', `/files/${uuid(32)}`);
    expect(within(second).getByText('Muntenia')).toBeInTheDocument();
    expect(within(second).getByText('12,500')).toBeInTheDocument();
    expect(within(second).getByText('S3')).toBeInTheDocument();
    expect(within(second).getByText('furtună')).toBeInTheDocument();

    // 25 a page, newest first; the unfiltered total is exact.
    expect(screen.getAllByRole('row')).toHaveLength(26);
    // Testing Library folds NBSP into a space when matching; the text itself keeps the NBSP thousands.
    expect(screen.getByText('Afișate 1–25 din 1 284 532').textContent).toBe(`Afișate 1–25 din 1${NBSP}284${NBSP}532`);
    const sent = readingRequests.at(-1)!.searchParams;
    expect(sent.get('page')).toBe('1');
    expect(sent.get('pageSize')).toBe('25');
  });

  it('offers and sends only what GET /meter-readings applies: meter id, zone and origin', async () => {
    nav.go('/files?category=meter&q=RO-BAN-000007&zone=banat&origin=storm&integrity=verified&storage=ftp&uploader=teren&from=2026-11-12&excludeGenerated=1&sort=-size');
    renderWithClient(<FilesScreen />);
    await screen.findByRole('link', { name: 'RO-DOB-000042' });

    const sent = readingRequests.at(-1)!.searchParams;
    expect(Object.fromEntries(sent)).toEqual({ meterId: 'RO-BAN-000007', zone: 'banat', origin: 'storm', page: '1', pageSize: '25' });

    // The search box looks for a meter; filters the readings cannot apply are not offered.
    expect(screen.getByRole('searchbox', { name: 'Contor' })).toHaveValue('RO-BAN-000007');
    for (const label of ['Integritate', 'Storage', 'Încărcat de', 'De la', 'Până la']) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Ascunde datele generate' })).toBeNull();
    const origins = within(screen.getByLabelText('Origine')).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(origins).toEqual(['', 'simulator', 'storm', 'seed']);

    // A change writes a clean, shareable URL with the meter view's filters only.
    fireEvent.change(screen.getByLabelText('Zonă'), { target: { value: 'muntenia' } });
    expect(nav.url()).toBe('/files?category=meter&q=RO-BAN-000007&zone=muntenia&origin=storm');
    await waitFor(() => expect(readingRequests.at(-1)!.searchParams.get('zone')).toBe('muntenia'));

    // No meter has an id with spaces: nothing is asked, the empty state says so.
    const asked = readingRequests.length;
    const box = screen.getByRole('searchbox', { name: 'Contor' });
    fireEvent.change(box, { target: { value: 'RO MUN 7' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByRole('heading', { name: 'Nicio citire pentru aceste filtre' })).toBeInTheDocument();
    expect(readingRequests).toHaveLength(asked);
  });

  it('pages on hasMore when a filtered total is only an estimate', async () => {
    nav.go('/files?category=meter&zone=banat');
    renderWithClient(<FilesScreen />);
    await screen.findByRole('link', { name: 'RO-DOB-000042' });

    expect(screen.getByText('Afișate 1–25')).toBeInTheDocument();
    expect(screen.queryByText(/ din /)).toBeNull();
    expect(screen.getByText('Pagina 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pagina următoare' }));
    expect(nav.url()).toBe('/files?category=meter&zone=banat&page=2');
    expect(await screen.findByText('Afișate 26–50')).toBeInTheDocument();
    await waitFor(() => expect(readingRequests.at(-1)!.searchParams.get('page')).toBe('2'));
  });
});
