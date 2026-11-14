import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { apiUrl } from '@/lib/api/base';
import { CATEGORY_IDS, type BulkheadResponse, type CategoryId } from '@/lib/monitoring/contract';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { useAppStore } from '@/stores/app-store';
import { renderWithClient } from '@/test/render';
import { BulkheadChart } from './BulkheadChart';
import BulkheadLines from './BulkheadLines';
import { BULKHEAD_SERIES, toRows } from './bulkhead-series';
import { toBulkhead } from './queries';

const NBSP = ' ';

// Recharts' ResponsiveContainer measures its box; jsdom has no layout, so give it one.
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: 720, height: 280 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const server = setupServer();
let base: Awaited<ReturnType<typeof buildHandlers>> = [];
beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  base = await buildHandlers(['auth', 'monitoring']);
  server.resetHandlers(...base);
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  db.reset();
  scenario.reset();
  startSession(SEED_USERS.find((u) => u.role === 'admin')!);
  useAppStore.setState({ livePaused: false });
});
afterEach(() => {
  server.resetHandlers(...base);
  scenario.stop();
});

const T0 = Date.parse('2026-11-14T19:00:00Z');
function fixture(): BulkheadResponse {
  const p95: Record<CategoryId, number | null> = { meter_readings: 420, fault_records: 3400, connection_documents: 900, drone_videos: null };
  return {
    window: '15m',
    stepS: 30,
    series: CATEGORY_IDS.map((category) => ({
      category,
      points: [0, 1, 2].map((i) => ({ t: new Date(T0 + i * 30_000).toISOString(), p95Ms: i === 0 && p95[category] !== null ? 500 : p95[category], opsPerS: 1 })),
    })),
    data: CATEGORY_IDS.map((category) => ({ category, active: category === 'fault_records' ? 12 : 1, queued: category === 'fault_records' ? 4 : 0 })),
  };
}

describe('BulkheadChart', () => {
  it('draws 4 series with token colours, distinct dash patterns and one y-axis', () => {
    const colours = CATEGORY_IDS.map((c) => BULKHEAD_SERIES[c].colorVar);
    expect(colours).toEqual(['--fg-cat-meter', '--fg-cat-fault', '--fg-cat-connection', '--fg-cat-drone']);
    expect(new Set(CATEGORY_IDS.map((c) => BULKHEAD_SERIES[c].dash)).size).toBe(4);

    const view = toBulkhead(fixture());
    const names = { meter_readings: 'Citiri contoare', fault_records: 'Avarii', connection_documents: 'Racordări', drone_videos: 'Video dronă' };
    const { container } = render(
      <div style={{ width: 720 }}>
        <BulkheadLines rows={toRows(view.series)} names={names} targetS={2} targetLabel={`țintă avarii 2${NBSP}s`} yLabel="p95 (secunde)" />
      </div>,
    );
    const lines = [...container.querySelectorAll('.recharts-line-curve')];
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.getAttribute('stroke'))).toEqual(colours.map((v) => `var(${v})`));
    expect(new Set(lines.map((l) => l.getAttribute('stroke-dasharray'))).size).toBe(4);
    expect(container.querySelectorAll('.recharts-yAxis')).toHaveLength(1);
    expect(container.querySelector('.recharts-reference-line')).not.toBeNull();
    expect([...container.querySelectorAll('text')].map((e) => e.textContent)).toContain(`țintă avarii 2${NBSP}s`);
  });

  it('labels each line at its end, and the table alternative holds every point', async () => {
    server.use(http.get(apiUrl('/metrics/bulkhead'), () => HttpResponse.json(fixture() as never)));
    renderWithClient(<BulkheadChart />);

    expect(await screen.findByText('Avarii 3,4 s')).toBeInTheDocument();
    expect(screen.getByText('Citiri contoare 0,4 s')).toBeInTheDocument();
    expect(screen.getByText('Video dronă fără date')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: /Latența p95 pe categorie/ });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(1 + 3);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Ora', 'Citiri contoare', 'Avarii', 'Racordări', 'Video dronă']);
    expect(rows[3]).toHaveTextContent('3,4 s');
    expect(rows[3]).toHaveTextContent('—');
    expect(screen.getByText(`12 active · 4 în coadă`)).toBeInTheDocument();
    expect(screen.getByText(/Cea mai lentă categorie acum: Avarii/)).toBeInTheDocument();
  });

  it('reads the mock backend', async () => {
    renderWithClient(<BulkheadChart />);
    expect(await screen.findByRole('table', { name: /ultimele 15 minute/ })).toBeInTheDocument();
    expect(screen.getAllByText(/^Avarii /).length).toBeGreaterThan(0);
  });

  it('keeps a valid answer and drops what it cannot trust', () => {
    const view = toBulkhead({ series: [{ category: 'fault', points: [{ t: 'nope', p95Ms: 1 }, { t: new Date(T0).toISOString(), p95Ms: 'x' }] }, { category: 'other', points: [] }], data: [{ category: 'drone_videos', active: -1, queued: 2 }] });
    expect(view.series).toEqual([{ category: 'fault_records', points: [{ t: new Date(T0).toISOString(), p95Ms: null, opsPerS: 0 }] }]);
    expect(view.compartments).toEqual([{ category: 'drone_videos', active: 0, queued: 2 }]);
  });
});
