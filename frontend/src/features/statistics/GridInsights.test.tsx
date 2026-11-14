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
import { GridInsights } from './GridInsights';

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

const figure = () => screen.findByRole('figure', { name: /Avarii pe zone/ });

/** [zone, fill] of every region drawn, west to east. */
const regions = (map: HTMLElement) => Array.from(map.querySelectorAll('path[data-zone]')).map((p) => [p.getAttribute('data-zone'), p.getAttribute('fill')]);

/** [name, count] printed on every region, west to east. */
const labels = (map: HTMLElement) =>
  Array.from(map.querySelectorAll('[data-region-label]')).map((g) => [g.querySelector('[data-name]')?.textContent, g.querySelector('[data-count]')?.textContent]);

/** A cell's text as a wide screen shows it: without the copies folded in for narrow screens (`[data-fold]`). */
function wide(cell: HTMLElement): string | null {
  const copy = cell.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-fold]').forEach((fold) => fold.remove());
  return copy.textContent;
}

/** The cells of every body row of a table. */
const cells = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map(wide));

/** The real backend's S3 answer: no `peakZone` or `faultsTotal`, its own text, zones without faults left out. */
function realAnswer(over: Record<string, unknown> = {}) {
  return {
    faultsByZone: [{ zone: 'dobrogea', county: null, count: 3 }, { zone: 'atlantis', county: null, count: 9 }],
    consumptionByHourZone: [{ zone: 'banat', hour: 19, avgKwh: 0.43 }],
    anomalies: [
      { meterId: 'M-0001', zone: 'banat', type: 'spike', detectedAt: '2026-11-14T10:00:00.000Z', value: 2.5, fileId: 'f-1' },
      { meterId: 'M-0002', zone: 'banat', type: 'mystery', detectedAt: '2026-11-14T12:00:00.000Z', value: 1, fileId: 'f-2' },
      { meterId: 'M-0003', zone: 'muntenia', type: 'zero', detectedAt: '2026-11-14T11:00:00.000Z', value: 0, fileId: 'f-3' },
    ],
    interpretation: {
      text: 'Cele mai multe avarii raportate: dobrogea (3).',
      recommendation: null,
      facts: { topFaultZone: 'dobrogea', peakHour: 19, anomalies: 2 },
    },
    ...over,
  };
}

describe('S3 grid insights', () => {
  it('draws the three regions with sequential fills and their fault counts', async () => {
    renderWithClient(<GridInsights />);
    expect(screen.getByRole('heading', { level: 2, name: 'Ce spun datele despre rețea' })).toBeInTheDocument();
    const fig = await figure();
    // The map's name carries every count, busiest region first.
    const map = within(fig).getByRole('img', { name: 'Avarii pe zone: Muntenia 38, Dobrogea 23, Banat 14' });
    // Three hand-drawn regions, west to east, filled from the single-hue sequential ramp by their count (max 38).
    expect(regions(map)).toEqual([
      ['banat', 'var(--fg-seq-3)'],
      ['muntenia', 'var(--fg-seq-5)'],
      ['dobrogea', 'var(--fg-seq-4)'],
    ]);
    // Every region is outlined, so even the lightest step stands apart from the card.
    for (const path of Array.from(map.querySelectorAll('path[data-zone]'))) expect(path.getAttribute('stroke')).toBe('var(--fg-ink)');
    // Colour is never the only encoding: each region prints its name and its count.
    expect(labels(map)).toEqual([['Banat', '14'], ['Muntenia', '38'], ['Dobrogea', '23']]);
    // The legend labels the ramp with numbers, from 0 to the busiest region.
    const legend = fig.querySelector<HTMLElement>('[data-legend]')!;
    expect(Array.from(legend.querySelectorAll('rect')).map((r) => r.getAttribute('fill'))).toEqual([1, 2, 3, 4, 5].map((n) => `var(--fg-seq-${n})`));
    expect(Array.from(legend.querySelectorAll('[data-bound]')).map((b) => b.textContent)).toEqual(['0', '38']);
  });

  it('says the map is schematic, not to scale', async () => {
    renderWithClient(<GridInsights />);
    expect(within(await figure()).getByText('Hartă schematică, nu la scară')).toBeInTheDocument();
  });

  it('lists the meter anomalies, newest first, in a table that wraps instead of scrolling sideways', async () => {
    renderWithClient(<GridInsights />);
    const table = await screen.findByRole('table', { name: 'Anomalii contoare' });
    expect(screen.getByRole('heading', { level: 3, name: 'Anomalii contoare' })).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Contor', 'Zonă', 'Anomalie', 'Detectată']);
    expect(cells(table)).toEqual([
      ['RO-MUN-000412', 'Muntenia', nb('Vârf brusc · 3,86~kWh'), '14 nov 19:45'],
      ['RO-DOB-000087', 'Dobrogea', 'Consum zero', '14 nov 18:30'],
      ['RO-BAN-000215', 'Banat', nb('Consum negativ · −0,42~kWh'), '14 nov 16:15'],
      ['RO-MUN-001203', 'Muntenia', 'Contor tăcut', '14 nov 13:00'],
      ['RO-DOB-000311', 'Dobrogea', nb('Vârf brusc · 2,95~kWh'), '14 nov 11:30'],
      ['RO-MUN-000058', 'Muntenia', 'Consum zero', '14 nov 08:15'],
    ]);
    // Wraps: the table takes the card's width and no ancestor scrolls sideways, so a narrow screen gets taller rows
    // instead of a scrollbar. Meter ids may break anywhere, every other cell between words, and nothing forbids wrapping.
    expect(table).toHaveClass('w-full');
    for (let el = table.parentElement; el; el = el.parentElement) expect(el.className).not.toMatch(/overflow-x-(auto|scroll)/);
    const [meter, zone, type, time] = within(within(table).getAllByRole('row')[1]!).getAllByRole('cell');
    expect(meter).toHaveClass('wrap-anywhere');
    for (const cell of [...within(table).getAllByRole('columnheader'), ...within(table).getAllByRole('cell')]) {
      expect(cell.className).toMatch(/\bwrap-(anywhere|break-word)\b/);
      expect(cell.className).not.toMatch(/\b(whitespace-nowrap|truncate)\b/);
    }
    // Below `sm` it folds to two columns: the zone goes under the meter and the time under the anomaly.
    const [, zoneHeader, , timeHeader] = within(table).getAllByRole('columnheader');
    for (const cell of [zoneHeader, timeHeader, zone, time]) expect(cell).toHaveClass('hidden', 'sm:table-cell');
    expect(Array.from(meter!.querySelectorAll('[data-fold]')).map((fold) => fold.textContent)).toEqual(['Muntenia']);
    expect(Array.from(type!.querySelectorAll('[data-fold]')).map((fold) => fold.textContent)).toEqual(['14 nov 19:45']);
    for (const fold of Array.from(table.querySelectorAll('[data-fold]'))) expect(fold).toHaveClass('sm:hidden');
  });

  it('shows the newest anomalies only and says how many there are', async () => {
    const anomalies = Array.from({ length: 12 }, (_, i) => ({
      meterId: `RO-MUN-${String(i).padStart(6, '0')}`,
      zone: 'muntenia',
      type: 'zero',
      detectedAt: new Date(Date.UTC(2026, 10, 14, i)).toISOString(),
      value: 0,
      fileId: null,
    }));
    server.use(http.get(apiUrl('/statistics/grid-insights'), () => HttpResponse.json(realAnswer({ anomalies }))));
    renderWithClient(<GridInsights />);
    const table = await screen.findByRole('table', { name: 'Anomalii contoare' });
    expect(cells(table).map(([meter]) => meter)).toEqual([11, 10, 9, 8, 7, 6, 5, 4].map((i) => `RO-MUN-${String(i).padStart(6, '0')}`));
    expect(screen.getByText('Cele mai recente 8 din 12 citiri anormale.')).toBeInTheDocument();
  });

  it('opens a table with the faults of every region', async () => {
    const user = userEvent.setup();
    renderWithClient(<GridInsights />);
    await figure();
    const toggle = screen.getByText('Vezi ca tabel');
    expect(toggle.closest('details')).not.toHaveAttribute('open');
    await user.click(toggle);
    expect(toggle.closest('details')).toHaveAttribute('open');
    const table = screen.getByRole('table', { name: 'Ce spun datele despre rețea' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Zonă', nb('Avarii în ultimele 24~h'), 'Din total']);
    expect(cells(table)).toEqual([
      ['Muntenia', '38', nb('50,7~%')],
      ['Banat', '14', nb('18,7~%')],
      ['Dobrogea', '23', nb('30,7~%')],
    ]);
  });

  it('ends with the interpretation and the recommendation, and the map points at the interpretation', async () => {
    renderWithClient(<GridInsights />);
    const interpretation = await screen.findByRole('group', { name: 'Interpretare' });
    expect(interpretation.querySelector('p')?.textContent).toBe(
      nb(
        'Muntenia are cele mai multe avarii în ultimele 24~h: 38 din 75, de 2,7× mai multe decât Banatul. '
        + 'Consumul atinge vârful la ora 19:00, în Muntenia (0,50~kWh în medie pe citire), iar 6 citiri sunt anormale.',
      ),
    );
    expect(within(screen.getByRole('group', { name: 'Recomandare' })).getByText(
      'Verificați contoarele cu citiri anormale, începând cu Muntenia: pot indica fraude sau defecte.',
    )).toBeInTheDocument();
    expect((await figure()).getAttribute('aria-describedby')).toBe(interpretation.id);
  });

  it('reads the real backend: zones without faults count 0, its text wins, unknown zones and anomaly types are dropped', async () => {
    server.use(http.get(apiUrl('/statistics/grid-insights'), () => HttpResponse.json(realAnswer())));
    renderWithClient(<GridInsights />);
    const map = within(await figure()).getByRole('img', { name: 'Avarii pe zone: Dobrogea 3, Muntenia 0, Banat 0' });
    expect(regions(map)).toEqual([
      ['banat', 'var(--fg-seq-1)'],
      ['muntenia', 'var(--fg-seq-1)'],
      ['dobrogea', 'var(--fg-seq-5)'],
    ]);
    expect(labels(map)).toEqual([['Banat', '0'], ['Muntenia', '0'], ['Dobrogea', '3']]);
    expect(cells(screen.getByRole('table', { name: 'Anomalii contoare' }))).toEqual([
      ['M-0003', 'Muntenia', 'Consum zero', '14 nov 13:00'],
      ['M-0001', 'Banat', nb('Vârf brusc · 2,50~kWh'), '14 nov 12:00'],
    ]);
    expect(screen.getByRole('group', { name: 'Interpretare' }).textContent).toContain('Cele mai multe avarii raportate: dobrogea (3).');
    expect(within(screen.getByRole('group', { name: 'Recomandare' })).getByText(
      'Verificați contoarele cu citiri anormale, începând cu Muntenia: pot indica fraude sau defecte.',
    )).toBeInTheDocument();
  });

  it('draws a quiet day: every region at 0 on the lightest step, and no anomaly', async () => {
    server.use(
      http.get(apiUrl('/statistics/grid-insights'), () =>
        HttpResponse.json(realAnswer({ faultsByZone: [], consumptionByHourZone: [], anomalies: [], interpretation: { text: null, recommendation: null, facts: { topFaultZone: null, peakHour: null, anomalies: 0 } } })),
      ),
    );
    renderWithClient(<GridInsights />);
    const map = within(await figure()).getByRole('img', { name: 'Avarii pe zone: Muntenia 0, Banat 0, Dobrogea 0' });
    expect(regions(map).map(([, fill]) => fill)).toEqual(['var(--fg-seq-1)', 'var(--fg-seq-1)', 'var(--fg-seq-1)']);
    // Exact textContent: getByText's matcher folds the no-break space into a plain one.
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === nb('Nicio citire anormală în ultimele 24~h.'))).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Anomalii contoare' })).toBeNull();
  });

  it('shows the error with its trace ID and a retry when the answer fails', async () => {
    server.use(
      http.get(apiUrl('/statistics/grid-insights'), () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'x', traceId: 'trace-s3' }, { status: 500, headers: { 'X-Trace-Id': 'trace-s3' } }),
      ),
    );
    renderWithClient(<GridInsights />);
    expect(await screen.findByText('trace-s3', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reîncearcă' })).toBeInTheDocument();
  });
});
