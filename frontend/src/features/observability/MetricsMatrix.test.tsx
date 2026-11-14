import { QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import type { Role } from '@/lib/api/types';
import { CATEGORY_IDS, type CategoryId, type MatrixWindow, type MetricsCell, type MetricsMatrix as Matrix, type StorageId } from '@/lib/monitoring/contract';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { useAppStore } from '@/stores/app-store';
import { renderWithClient } from '@/test/render';
import { MetricsMatrix } from './MetricsMatrix';
import { toMetricsMatrix } from './queries';

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
  login('admin');
  useAppStore.setState({ livePaused: false });
});
afterEach(() => {
  server.resetHandlers(...base);
  scenario.stop();
  vi.useRealTimers();
  setVisibility('visible');
});

/** Switches the page between visible and hidden as a browser does when the tab changes. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Waits with the real setTimeout (the tests fake only setInterval, the timer behind TanStack's refetchInterval). */
async function eventually(check: () => void, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
}

/** Lets any request already started finish, so "no new request" is not just "not answered yet". */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 80)));

type Overrides = Partial<Record<`${CategoryId}:${StorageId}`, Partial<MetricsCell>>>;

/** Each category on its seed policy's primary storage, the other eight combinations without traffic. */
const ACTIVE: Overrides = {
  'meter_readings:db': { requests: 3000, p50Ms: 4, p95Ms: 11, p99Ms: 19, throughputBps: 2_600_000, opsPerS: 10, errorRate: 0 },
  'fault_records:s3': { requests: 750, p50Ms: 120, p95Ms: 410, p99Ms: 890, throughputBps: 3_400_000, opsPerS: 2.5, errorRate: 0.002 },
  'connection_documents:s3': { requests: 90, p50Ms: 95, p95Ms: 240, p99Ms: 520, throughputBps: 1_200_000, opsPerS: 0.3, errorRate: 0 },
  'drone_videos:ftp': { requests: 60, p50Ms: 1800, p95Ms: 4200, p99Ms: 6100, throughputBps: 48_000_000, opsPerS: 0.2, errorRate: 0 },
};

function fixture(window: MatrixWindow, overrides: Overrides = {}): Matrix {
  const cells = CATEGORY_IDS.flatMap((category) =>
    (['s3', 'ftp', 'db'] as const).map((storage): MetricsCell => {
      const key = `${category}:${storage}` as const;
      const patch = { ...ACTIVE[key], ...overrides[key] };
      const traffic = (patch.requests ?? 0) > 0;
      return {
        category, storage, requests: 0, noTraffic: !traffic,
        p50Ms: null, p95Ms: null, p99Ms: null, throughputBps: null, opsPerS: null, errorRate: null,
        ...patch,
      };
    }),
  );
  return { window, generatedAt: '2026-11-14T13:33:10.000Z', cells };
}

const serve = (body: (window: MatrixWindow) => Matrix) =>
  server.use(http.get(apiUrl('/metrics/matrix'), ({ request }) => HttpResponse.json(body((new URL(request.url).searchParams.get('window') ?? '5m') as MatrixWindow))));

const ROWS = ['Citiri contoare', 'Avarii', 'Racordări', 'Video dronă'];
const COLUMNS = ['Postgres', 'S3', 'FTP'];
const STORAGE_NAME: Record<StorageId, string> = { db: 'Postgres', s3: 'S3', ftp: 'FTP' };

/** The cell of one category (row header) and storage (column header). */
function cellAt(table: HTMLElement, category: string, storage: string): HTMLElement {
  const row = within(table).getAllByRole('row').find((r) => within(r).queryByRole('rowheader')?.textContent === category);
  if (!row) throw new Error(`no row ${category}`);
  return within(row).getAllByRole('cell')[COLUMNS.indexOf(storage)]!;
}

describe('MetricsMatrix', () => {
  it('is a real table: the 4 categories as rows × the 3 storages as columns, each cell with p50/p95/p99, throughput and error rate', async () => {
    serve((w) => fixture(w));
    renderWithClient(<MetricsMatrix window="5m" />);
    const table = await screen.findByRole('table', { name: /^Latență, debit și erori pe categorie și storage, ultimele 5 minute/ });
    const [head, ...rows] = within(table).getAllByRole('row');
    expect(within(head!).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Categorie', ...COLUMNS]);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(ROWS);
    for (const r of rows) expect(within(r).getAllByRole('cell')).toHaveLength(3);

    const fault = cellAt(table, 'Avarii', 'S3').textContent;
    for (const part of [`p50${NBSP}120${NBSP}ms`, `p95${NBSP}410${NBSP}ms`, `p99${NBSP}890${NBSP}ms`, `3,2${NBSP}MB/s`, `2,5${NBSP}op/s`, `0,2${NBSP}%${NBSP}erori`]) {
      expect(fault).toContain(part);
    }
    const drone = cellAt(table, 'Video dronă', 'FTP').textContent;
    for (const part of [`p50${NBSP}1,8${NBSP}s`, `p95${NBSP}4,2${NBSP}s`, `p99${NBSP}6,1${NBSP}s`, `45,8${NBSP}MB/s`, `0${NBSP}%${NBSP}erori`]) {
      expect(drone).toContain(part);
    }
    expect(drone).not.toContain('0,0');
    expect(cellAt(table, 'Citiri contoare', 'Postgres').textContent).toContain(`10${NBSP}op/s`);
  });

  it('says "fără trafic" in a cell where the category did not use that storage', async () => {
    serve((w) => fixture(w));
    renderWithClient(<MetricsMatrix window="5m" />);
    const table = await screen.findByRole('table');
    const empty = cellAt(table, 'Citiri contoare', 'S3');
    expect(empty.textContent).toBe('fără trafic');
    expect(empty).toHaveAttribute('data-traffic', 'none');
    expect(within(table).getAllByText('fără trafic')).toHaveLength(8);
    expect(cellAt(table, 'Avarii', 'S3')).toHaveAttribute('data-traffic', 'some');
  });

  it('marks a cell whose error rate is over the threshold with "Peste prag", in words and an icon, and dashes missing latencies', async () => {
    serve((w) =>
      fixture(w, {
        'fault_records:s3': { requests: 40, p50Ms: null, p95Ms: null, p99Ms: null, throughputBps: null, opsPerS: 0.13, errorRate: 1 },
        'fault_records:db': { requests: 700, p50Ms: 150, p95Ms: 510, p99Ms: 990, throughputBps: 2_900_000, opsPerS: 2.3, errorRate: 0 },
        'drone_videos:s3': { requests: 12, p50Ms: 500, p95Ms: 960, p99Ms: 1300, throughputBps: 32_000_000, opsPerS: 0.04, errorRate: 0.0004 },
      }),
    );
    renderWithClient(<MetricsMatrix window="5m" />);
    const table = await screen.findByRole('table');
    const s3 = cellAt(table, 'Avarii', 'S3');
    expect(s3).toHaveAttribute('data-over', 'true');
    expect(within(s3).getByText('Peste prag').closest('[data-tone]')?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(s3.textContent).toContain(`100${NBSP}%${NBSP}erori`);
    expect(s3.textContent).toContain(`p95${NBSP}—`);
    const fallback = cellAt(table, 'Avarii', 'Postgres');
    expect(fallback).toHaveAttribute('data-over', 'false');
    expect(within(fallback).queryByText('Peste prag')).toBeNull();
    expect(screen.getByText(/Peste prag: rata de erori peste 1/)).toBeInTheDocument();
    // A cell with traffic never reads "0 op/s" or "0 % erori" because a small rate rounded down.
    const slow = cellAt(table, 'Video dronă', 'S3').textContent;
    expect(slow).toContain(`<${NBSP}0,1${NBSP}op/s`);
    expect(slow).toContain(`<${NBSP}0,1${NBSP}%${NBSP}erori`);
  });

  it('reads the mock backend: each category on the storage its policy writes to, the other combinations without traffic', async () => {
    renderWithClient(<MetricsMatrix window="5m" />);
    const table = await screen.findByRole('table');
    const served = scenario.matrix('5m').cells.filter((c) => !c.noTraffic);
    expect(served.map((c) => c.category)).toEqual([...CATEGORY_IDS]);
    for (const c of served) {
      const cell = cellAt(table, ROWS[CATEGORY_IDS.indexOf(c.category)]!, STORAGE_NAME[c.storage]);
      expect(cell.textContent).toMatch(new RegExp(`p95${NBSP}\\d+(,\\d)?${NBSP}m?s`));
    }
    expect(within(table).getAllByText('fără trafic')).toHaveLength(8);
  });

  it('polls every 5 s, and stops while "Actualizări live" is paused or the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let calls = 0;
    server.use(
      http.get(apiUrl('/metrics/matrix'), () => {
        calls += 1;
        return HttpResponse.json(fixture('5m'));
      }),
    );
    renderWithClient(<MetricsMatrix window="5m" />);
    await eventually(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(calls).toBe(1);

    vi.advanceTimersByTime(4_900);
    await settle();
    expect(calls).toBe(1);
    vi.advanceTimersByTime(100);
    await eventually(() => expect(calls).toBe(2));
    vi.advanceTimersByTime(5_000);
    await eventually(() => expect(calls).toBe(3));

    // Paused: the data is frozen.
    act(() => useAppStore.getState().setLivePaused(true));
    vi.advanceTimersByTime(20_000);
    await settle();
    expect(calls).toBe(3);
    expect(screen.getByText(/Actualizări live în pauză/)).toBeInTheDocument();

    // Resumed: the latest snapshot at once, then every 5 s again.
    act(() => useAppStore.getState().setLivePaused(false));
    await eventually(() => expect(calls).toBe(4));
    vi.advanceTimersByTime(5_000);
    await eventually(() => expect(calls).toBe(5));

    // Hidden tab: no requests nobody sees; visible again: refreshed at once.
    setVisibility('hidden');
    vi.advanceTimersByTime(20_000);
    await settle();
    expect(calls).toBe(5);
    setVisibility('visible');
    await eventually(() => expect(calls).toBe(6));

    // Every refresh updated the same table in place.
    expect(screen.getByRole('table')).toBe(table);
  });

  it('keeps the previous matrix on screen while another window loads (keepPreviousData: no flash)', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(apiUrl('/metrics/matrix'), async ({ request }) => {
        const window = (new URL(request.url).searchParams.get('window') ?? '5m') as MatrixWindow;
        if (window === '1h') await held;
        return HttpResponse.json(fixture(window, window === '1h' ? { 'fault_records:s3': { p95Ms: 650 } } : {}));
      }),
    );
    const { client, rerender } = renderWithClient(<MetricsMatrix window="5m" />);
    const table = await screen.findByRole('table', { name: /ultimele 5 minute/ });
    const region = table.closest('[aria-busy]')!;
    expect(region).toHaveAttribute('aria-busy', 'false');

    rerender(
      <QueryClientProvider client={client}>
        <MetricsMatrix window="1h" />
      </QueryClientProvider>,
    );
    await settle();
    // Still the 5 minute numbers, in the same table, marked busy; no skeleton, no loading text in its place.
    expect(screen.getByRole('table')).toBe(table);
    expect(table).toHaveAccessibleName(/ultimele 5 minute/);
    expect(cellAt(table, 'Avarii', 'S3').textContent).toContain(`p95${NBSP}410${NBSP}ms`);
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Se încarcă…')).toBeNull();

    release();
    await waitFor(() => expect(table).toHaveAccessibleName(/ultima oră/));
    expect(screen.getByRole('table')).toBe(table);
    expect(cellAt(table, 'Avarii', 'S3').textContent).toContain(`p95${NBSP}650${NBSP}ms`);
    expect(region).toHaveAttribute('aria-busy', 'false');
  });

  it('shows a safe error with a retry when the matrix cannot be read', async () => {
    server.use(http.get(apiUrl('/metrics/matrix'), () => HttpResponse.json({ code: 'FORBIDDEN', message: 'x', traceId: 't-9' }, { status: 403 })));
    renderWithClient(<MetricsMatrix window="5m" />);
    expect(await screen.findByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
    expect(screen.getByText('Nu ai acces la această acțiune.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('toMetricsMatrix', () => {
  it('keeps the real contract, maps the proposal ids, drops what it cannot trust', () => {
    const parsed = toMetricsMatrix({
      window: '1h',
      generatedAt: '2026-11-14T13:33:10.000Z',
      cells: [
        { category: 'fault', storage: 'S3', requests: 5, noTraffic: false, p50Ms: 10, p95Ms: '40', p99Ms: Number.NaN, throughputBps: 100, opsPerS: 1, errorRate: 0 },
        { category: 'drone_videos', storage: 'ftp', requests: 0, noTraffic: true, p50Ms: null, p95Ms: null, p99Ms: null, throughputBps: null, opsPerS: null, errorRate: null },
        { category: 'teleport', storage: 's3', requests: 1 },
        { category: 'meter_readings', storage: 'tape', requests: 1 },
        null,
      ],
    });
    expect(parsed.window).toBe('1h');
    expect(parsed.generatedAt).toBe('2026-11-14T13:33:10.000Z');
    expect(parsed.cells).toEqual([
      { category: 'fault_records', storage: 's3', requests: 5, noTraffic: false, p50Ms: 10, p95Ms: null, p99Ms: null, throughputBps: 100, opsPerS: 1, errorRate: 0 },
      { category: 'drone_videos', storage: 'ftp', requests: 0, noTraffic: true, p50Ms: null, p95Ms: null, p99Ms: null, throughputBps: null, opsPerS: null, errorRate: null },
    ]);
    expect(toMetricsMatrix({ window: 'forever', generatedAt: 'yesterday-ish', cells: [{ category: 'fault_records', storage: 'db', requests: 0 }] })).toMatchObject({
      window: null,
      generatedAt: null,
      cells: [{ category: 'fault_records', storage: 'db', requests: 0, noTraffic: true }],
    });
    expect(toMetricsMatrix(undefined)).toEqual({ window: null, generatedAt: null, cells: [] });
  });
});
