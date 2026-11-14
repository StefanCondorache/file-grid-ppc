import { QueryClientProvider } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl } from '@/lib/api/base';
import { qk } from '@/lib/api/query-keys';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import type { Period, PeriodComparison as PeriodComparisonData } from './contract';
import { PeriodComparison } from './PeriodComparison';

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
const nb = (text: string) => text.replace(/~/g, ' ');

const NORMAL_12 = 'p-2026-11-12-normal';
const STORM_14 = 'p-2026-11-14-storm';
const normal13: Period = {
  id: 'p-normal-13', label: 'Zi normală · 13 nov', kind: 'normal', origin: 'simulator', start: '2026-11-12T22:00:00.000Z', end: '2026-11-13T21:59:59.000Z',
};

const CATEGORIES = ['Citiri contoare', 'Avarii', 'Racordări', 'Video dronă'];

const figure = () => screen.findByRole('figure', { name: /Timp de scriere \(p95\)/ });

/** The dumbbells, one per category, in the S2 figure. */
async function dumbbells() {
  return Array.from((await figure()).querySelectorAll<HTMLElement>('[data-dumbbell]'));
}

const dumbbell = async (name: string) => (await dumbbells()).find((row) => row.querySelector('[data-label]')?.textContent === name)!;
const dot = (row: HTMLElement, which: 'a' | 'b') => row.querySelector<HTMLElement>(`[data-dot="${which}"]`)!;

describe('S2 normal vs peak', () => {
  it('draws one dumbbell per category: hollow = the normal day (A), filled = the peak (B)', async () => {
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Zi normală vs. zi de vârf' })).toBeInTheDocument();
    const rows = await dumbbells();
    expect(rows.map((row) => row.querySelector('[data-label]')?.textContent)).toEqual(CATEGORIES);

    // The legend names both periods next to their marker shape.
    const chart = await figure();
    const legend = within(chart).getByRole('list', { name: 'Legendă' });
    const hollowKey = within(legend).getByText('Perioada A: Zi normală · 12 nov').closest('li')!;
    const filledKey = within(legend).getByText('Perioada B: Furtună · 14 nov 15:33').closest('li')!;
    expect(hollowKey.querySelector('[data-dot="a"]')).not.toBeNull();
    expect(filledKey.querySelector('[data-dot="b"]')).not.toBeNull();

    const faults = await dumbbell('Avarii');
    const a = dot(faults, 'a');
    const b = dot(faults, 'b');
    // Hollow: an outline in ink and no fill; filled: the category colour, so shape (not colour) tells A from B.
    expect(a.className).toMatch(/\bborder-ink-2\b/);
    expect(a.className).not.toMatch(/\bbg-(cat|ink|surface)/);
    expect(b.className.match(/\bbg-cat-[a-z]+/g)).toEqual(['bg-cat-fault']);
    expect(b.className).not.toMatch(/\bborder-ink/);
    // Faults: 0,6 s on the normal day, 3,4 s in the storm, on a 0–4 s axis.
    expect(parseFloat(a.style.left)).toBeCloseTo(15, 1);
    expect(parseFloat(b.style.left)).toBeCloseTo(85, 1);
    // The peak dot of every category takes that category's colour.
    const expected = ['bg-cat-meter', 'bg-cat-fault', 'bg-cat-connection', 'bg-cat-drone'];
    expect(rows.map((row) => dot(row, 'b').className.match(/\bbg-cat-[a-z]+/)?.[0])).toEqual(expected);
    // Screen readers get the two values in words; the drawing itself is hidden from them. (Compared on textContent:
    // Testing Library's text matchers fold the no-break space into a plain one.)
    expect(Array.from(faults.querySelectorAll('.sr-only')).map((el) => el.textContent)).toEqual([nb('Perioada A: 0,6~s; perioada B: 3,4~s (+467~%).')]);
    expect(faults.querySelector('[data-track]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the shared axis from 0 to 4 s', async () => {
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    const chart = await figure();
    expect(chart).toHaveAccessibleName(nb('Timp de scriere (p95) pe categorie · axa 0–4~s'));
    const ticks = Array.from(chart.querySelectorAll<HTMLElement>('[data-tick]'));
    expect(ticks.map((t) => t.textContent)).toEqual(['0~s', '1~s', '2~s', '3~s', '4~s'].map(nb));
    expect(ticks.map((t) => parseFloat(t.style.left))).toEqual([0, 25, 50, 75, 100]);
  });

  it('prints each change as "0,6 → 3,4 s" with its delta "+467 %"', async () => {
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    const values = (await dumbbells()).map((row) => [row.querySelector('[data-value]')?.textContent, row.querySelector('[data-delta]')?.textContent]);
    expect(values).toEqual([
      [nb('42 → 45~ms'), nb('+7~%')],
      [nb('0,6 → 3,4~s'), nb('+467~%')],
      [nb('0,25 → 0,27~s'), nb('+6~%')],
      [nb('1,4 → 1,48~s'), nb('+6~%')],
    ]);
  });

  it('ends with the interpretation and the recommendation, and the chart points at the interpretation', async () => {
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    const interpretation = await screen.findByRole('group', { name: 'Interpretare' });
    expect(within(interpretation).getByRole('paragraph').textContent).toBe(
      nb('În „Furtună · 14 nov 15:33”, avariile au crescut de 10×, iar p95 la scriere a urcat de la 0,6~s la 3,4~s (+467~%). ')
        + 'Celelalte categorii și-au păstrat timpii de răspuns: compartimentele (bulkhead) le-au izolat de vârf.',
    );
    expect(screen.getByRole('group', { name: 'Recomandare' })).toHaveTextContent(
      'Păstrați limitele de concurență din politici, care au izolat vârful, și adăugați instanțe de backend pentru avarii în zilele de vârf.',
    );
    expect((await figure()).getAttribute('aria-describedby')).toBe(interpretation.id);
  });

  it('reads the real backend: its text wins, rows come in any order, unknown metrics are dropped', async () => {
    const period = (id: string, label: string, kind: string) => ({ id, label, kind, origin: kind === 'peak' ? 'storm' : 'simulator', start: '2026-11-14T10:00:00.000Z', end: null });
    server.use(
      http.get(apiUrl('/statistics/period-comparison'), () =>
        HttpResponse.json({
          periodA: period('pa', 'Zi normală · 13 nov', 'normal'),
          periodB: period('pb', 'Furtună · 14 nov 16:02', 'peak'),
          rows: [
            { category: 'drone_videos', metric: 'p95Ms', a: 900, b: 950, deltaPct: 5.6 },
            { category: 'fault_records', metric: 'p95Ms', a: 500, b: 2_100, deltaPct: 320 },
            { category: 'fault_records', metric: 'latencyMs', a: 1, b: 2, deltaPct: 100 },
            { category: 'meter_readings', metric: 'p95Ms', a: null, b: null, deltaPct: null },
            { category: 'connection_documents', metric: 'p95Ms', a: 300, b: 310, deltaPct: 3.3 },
          ],
          interpretation: { text: 'Citirile de contor s-au schimbat de 10 ori (5 → 50 citiri/s).', recommendation: null, facts: { factor: 10, isolated: true } },
        }),
      ),
    );
    renderWithClient(<PeriodComparison a="pa" b="pb" />);
    expect((await dumbbells()).map((row) => [row.querySelector('[data-label]')?.textContent, row.querySelector('[data-value]')?.textContent])).toEqual([
      ['Citiri contoare', 'nemăsurat'],
      ['Avarii', nb('0,5 → 2,1~s')],
      ['Racordări', nb('0,3 → 0,31~s')],
      ['Video dronă', nb('0,9 → 0,95~s')],
    ]);
    // 2,1 s rounds the axis up to 0–2,5 s.
    expect(await figure()).toHaveAccessibleName(nb('Timp de scriere (p95) pe categorie · axa 0–2,5~s'));
    expect(within(screen.getByRole('group', { name: 'Interpretare' })).getByRole('paragraph').textContent).toBe(
      'Citirile de contor s-au schimbat de 10 ori (5 → 50 citiri/s).',
    );
    // No backend recommendation: templated from the rows, which name the faults as the category the peak hit.
    expect(within(screen.getByRole('group', { name: 'Recomandare' })).getByRole('paragraph').textContent).toBe(
      'Păstrați limitele de concurență din politici, care au izolat vârful, și adăugați instanțe de backend pentru avarii în zilele de vârf.',
    );
  });

  it('opens a table with every category × metric for both periods and the difference', async () => {
    const user = userEvent.setup();
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    await dumbbells();
    const summary = screen.getByText('Vezi ca tabel');
    // Closed until asked for (6f.6 opens each chart's table). jsdom still exposes a closed <details>, so check `open`.
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');

    const table = screen.getByRole('table', { name: 'Zi normală vs. zi de vârf' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Categorie', 'Indicator', 'Perioada A (Zi normală · 12 nov)', 'Perioada B (Furtună · 14 nov 15:33)', 'Diferență',
    ]);
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(16);
    const cells = (i: number) => within(body[i]!).getAllByRole('cell').map((td) => td.textContent);
    // Row order: categories as on the chart, then p95 · operații/s · erori · volum.
    expect(cells(4)).toEqual(['Avarii', 'p95 la scriere', nb('0,6~s'), nb('3,4~s'), nb('+467~%')]);
    expect(cells(5)).toEqual(['Avarii', 'Operații/s', '0,01', '0,1', nb('+900~%')]);
    expect(cells(6)).toEqual(['Avarii', 'Rata de erori', nb('0,2~%'), nb('1,1~%'), nb('+450~%')]);
    expect(cells(7)).toEqual(['Avarii', 'Volum', nb('4,22~GB'), nb('450,0~MB'), nb('−90~%')]);
    expect(cells(3)).toEqual(['Citiri contoare', 'Volum', nb('4~320~000 de citiri'), nb('46~800 de citiri'), nb('−99~%')]);
    // No delta from a zero: a dash, named for screen readers.
    expect(cells(2)).toEqual(['Citiri contoare', 'Rata de erori', nb('0,0~%'), nb('0,0~%'), '—nu se poate calcula']);
  });

  it('refetches under qk.stats.s2(a, b) when the compared periods change', async () => {
    db.insert('periods', normal13);
    const asked: string[] = [];
    const track = ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/statistics/period-comparison')) asked.push(`${url.searchParams.get('a')} vs ${url.searchParams.get('b')}`);
    };
    server.events.on('request:start', track);
    const { client, rerender } = renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    expect(await screen.findByText('Perioada A: Zi normală · 12 nov')).toBeInTheDocument();
    expect(client.getQueryData<PeriodComparisonData>(qk.stats.s2(NORMAL_12, STORM_14))?.periodA.id).toBe(NORMAL_12);

    rerender(
      <QueryClientProvider client={client}>
        <PeriodComparison a={normal13.id} b={STORM_14} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Perioada A: Zi normală · 13 nov')).toBeInTheDocument();
    server.events.removeListener('request:start', track);
    expect(asked).toEqual([`${NORMAL_12} vs ${STORM_14}`, `${normal13.id} vs ${STORM_14}`]);
    expect(client.getQueryData<PeriodComparisonData>(qk.stats.s2(normal13.id, STORM_14))?.periodA.label).toBe('Zi normală · 13 nov');
  });

  it('asks for nothing until both periods exist, and says why', async () => {
    const asked: string[] = [];
    const track = ({ request }: { request: Request }) => void asked.push(new URL(request.url).pathname);
    server.events.on('request:start', track);
    renderWithClient(<PeriodComparison a={NORMAL_12} b={null} />);
    expect(await screen.findByRole('heading', { name: 'Alegeți perioadele de comparat.' })).toBeInTheDocument();
    server.events.removeListener('request:start', track);
    expect(asked.filter((p) => p.endsWith('/statistics/period-comparison'))).toEqual([]);
  });

  it('shows the error with its trace ID and a retry when the comparison fails', async () => {
    server.use(
      http.get(apiUrl('/statistics/period-comparison'), () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'x', traceId: 'trace-s2' }, { status: 404, headers: { 'X-Trace-Id': 'trace-s2' } }),
      ),
    );
    renderWithClient(<PeriodComparison a={NORMAL_12} b={STORM_14} />);
    expect(await screen.findByText('trace-s2', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
  });
});
