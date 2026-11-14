import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { StorageFit } from './StorageFit';

const server = setupServer();
let mocks: RequestHandler[] = [];
beforeAll(async () => {
  mocks = await buildHandlers(['auth', 'statistics']);
  server.resetHandlers(...mocks);
  server.listen({ onUnhandledRequest: 'error' });
});
// Drops the per-test overrides (server.use) and keeps the statistics mock.
afterEach(() => server.resetHandlers(...mocks));
afterAll(() => server.close());

beforeEach(() => {
  db.reset();
  startSession(SEED_USERS.find((u) => u.role === 'auditor')!);
});

/** `~` stands for the no-break space the Romanian number format puts before units and between thousands. */
const nb = (text: string) => text.replace(/~/g, '\u00A0');

const CATEGORIES = ['Citiri contoare', 'Avarii', 'Racordări', 'Video dronă'];

/** The four small multiples, one group per category, inside the S1 figure. */
async function facets() {
  const figure = await screen.findByRole('figure', { name: /p95 la scriere/ });
  return within(figure).getAllByRole('group');
}

const facet = async (name: string) => (await facets()).find((g) => within(g).queryByRole('heading', { level: 3, name }))!;

/** One storage row of a facet: [axis label, value]. */
const rows = (group: HTMLElement) =>
  within(group).getAllByRole('listitem').map((li) => [li.querySelector('[data-axis]')?.textContent, li.querySelector('[data-value]')?.textContent]);

describe('S1 storage fit', () => {
  it('draws one small multiple per category under the S1 question', async () => {
    renderWithClient(<StorageFit />);
    expect(screen.getByRole('heading', { level: 2, name: 'Ce storage se potrivește fiecărei categorii?' })).toBeInTheDocument();
    const groups = await facets();
    expect(groups.map((g) => within(g).getByRole('heading', { level: 3 }).textContent)).toEqual(CATEGORIES);
    // Every facet shows the three storages, measured or not.
    for (const g of groups) expect(within(g).getAllByRole('listitem')).toHaveLength(3);
  });

  it('puts the storages on the axis, in the same order everywhere, and colours the bars by category only', async () => {
    renderWithClient(<StorageFit />);
    const faults = await facet('Avarii');
    // Faults: S3 p95 0,6 s vs FTP 1,8 s; DB never served them.
    expect(rows(faults)).toEqual([['S3', nb('0,6~s')], ['FTP', nb('1,8~s')], ['DB', 'nemăsurat']]);
    const meters = await facet('Citiri contoare');
    expect(rows(meters)).toEqual([['S3', 'nemăsurat'], ['FTP', 'nemăsurat'], ['DB', nb('42~ms')]]);

    // Shorter bar = faster: the S3 bar is a third of the FTP bar.
    const [s3, ftp, ...rest] = Array.from(faults.querySelectorAll<HTMLElement>('[data-bar]'));
    expect(rest).toHaveLength(0);
    expect(parseFloat(s3!.style.width)).toBeCloseTo(33.3, 0);
    expect(parseFloat(ftp!.style.width)).toBe(100);

    // No storage colours: every bar of a facet carries its category colour, and nothing else does.
    const expected: Record<string, string> = { 'Citiri contoare': 'bg-cat-meter', Avarii: 'bg-cat-fault', Racordări: 'bg-cat-connection', 'Video dronă': 'bg-cat-drone' };
    for (const g of await facets()) {
      const name = within(g).getByRole('heading', { level: 3 }).textContent!;
      const bars = Array.from(g.querySelectorAll<HTMLElement>('[data-bar]'));
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) expect(bar.className.match(/\bbg-cat-[a-z]+/g)).toEqual([expected[name]]);
      for (const axis of Array.from(g.querySelectorAll<HTMLElement>('[data-axis]'))) expect(axis.className).not.toMatch(/\b(bg|text|border)-cat-/);
    }
  });

  it('tags the recommended storage of each category', async () => {
    renderWithClient(<StorageFit />);
    expect(within(await facet('Avarii')).getByText('Recomandat: S3')).toBeInTheDocument();
    expect(within(await facet('Citiri contoare')).getByText('Recomandat: DB')).toBeInTheDocument();
    expect(within(await facet('Racordări')).getByText('Recomandat: DB')).toBeInTheDocument();
    expect(within(await facet('Video dronă')).getByText('Recomandat: S3')).toBeInTheDocument();
  });

  it('shows the interpretation and the recommendation as two blocks, one line per category', async () => {
    renderWithClient(<StorageFit />);
    const interpretation = await screen.findByRole('group', { name: 'Interpretare' });
    const recommendation = screen.getByRole('group', { name: 'Recomandare' });
    const lines = (block: HTMLElement) => within(block).getAllByRole('listitem').map((li) => li.textContent);

    expect(lines(interpretation)).toHaveLength(4);
    expect(lines(interpretation)[1]).toBe(nb('Avarii: Avariile se scriu de 3× mai repede pe S3 decât pe FTP (p95 0,6~s față de 1,8~s).'));
    expect(lines(recommendation)[1]).toBe('Avarii: Păstrați avariile pe S3, unde p95 este de 3× mai mic decât pe FTP.');
    expect(lines(recommendation)[0]).toBe('Citiri contoare: Păstrați citirile de contor pe DB.');
    // The chart is described by its interpretation (A11Y-19).
    const figure = screen.getByRole('figure', { name: /p95 la scriere/ });
    expect(figure.getAttribute('aria-describedby')).toBe(interpretation.id);
  });

  it('keeps the backend text when the real backend sends it, and still recommends when it sends none', async () => {
    server.use(
      http.get(apiUrl('/statistics/storage-fit'), () =>
        HttpResponse.json({
          items: [{
            category: 'fault_records',
            storages: [
              { storage: 's3', samples: 40, p50Ms: 210, p95Ms: 580, throughputBps: 9_000_000, errorRate: 0 },
              { storage: 'ftp', samples: 12, p50Ms: 700, p95Ms: 1_700, throughputBps: 3_000_000, errorRate: 0 },
              { storage: 'db', samples: 0, p50Ms: null, p95Ms: null, throughputBps: null, errorRate: null },
            ],
            recommendedStorage: 's3',
            interpretation: { text: 'S3 se potrivește pentru această categorie.', recommendation: null, facts: { primaryStorage: 's3', fastest: 's3' } },
          }],
        }),
      ),
    );
    renderWithClient(<StorageFit />);
    const interpretation = await screen.findByRole('group', { name: 'Interpretare' });
    expect(within(interpretation).getByRole('listitem').textContent).toBe('Avarii: S3 se potrivește pentru această categorie.');
    expect(within(screen.getByRole('group', { name: 'Recomandare' })).getByRole('listitem').textContent).toBe(
      'Avarii: Păstrați avariile pe S3, unde p95 este de 2,9× mai mic decât pe FTP.',
    );
  });

  it('opens a table with every category × storage measurement', async () => {
    const user = userEvent.setup();
    renderWithClient(<StorageFit />);
    await facets();
    // Closed until asked for (6f.6 opens each chart's table). jsdom still exposes a closed <details>, so check `open`.
    expect(screen.getByText('Vezi ca tabel').closest('details')).not.toHaveAttribute('open');
    await user.click(screen.getByText('Vezi ca tabel'));
    expect(screen.getByText('Vezi ca tabel').closest('details')).toHaveAttribute('open');
    const table = screen.getByRole('table', { name: 'Ce storage se potrivește fiecărei categorii?' });
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Categorie', 'Storage', 'Operații', 'p50', 'p95', 'Debit', 'Erori', 'Recomandat']);
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(12);
    const cells = (i: number) => within(body[i]!).getAllByRole('cell').map((td) => td.textContent);
    // Row order: categories as on the chart, storages S3 · FTP · DB.
    expect(cells(3)).toEqual(['Avarii', 'S3', nb('1~240'), nb('0,24~s'), nb('0,6~s'), nb('8,3~MB/s'), nb('0,2~%'), 'da']);
    expect(cells(4)).toEqual(['Avarii', 'FTP', '96', nb('0,76~s'), nb('1,8~s'), nb('2,8~MB/s'), nb('1,0~%'), 'nu']);
    expect(cells(0)).toEqual(['Citiri contoare', 'S3', '0', '—nemăsurat', '—nemăsurat', '—nemăsurat', '—nemăsurat', 'nu']);
  });

  it('shows the error with its trace ID and a retry when the answer fails', async () => {
    server.use(
      http.get(apiUrl('/statistics/storage-fit'), () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'x', traceId: 'trace-s1' }, { status: 500, headers: { 'X-Trace-Id': 'trace-s1' } }),
      ),
    );
    renderWithClient(<StorageFit />);
    expect(await screen.findByText('trace-s1', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
  });
});
