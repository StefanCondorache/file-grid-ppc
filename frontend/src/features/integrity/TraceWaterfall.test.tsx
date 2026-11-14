import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileDetailScreen } from '@/features/files/FileDetailScreen';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { SEED_FILES } from '@/mocks/seed/files';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { TraceActions, TraceTable, type Trace } from './TraceWaterfall';

const login = (username: string) => startSession(SEED_USERS.find((u) => u.username === username)!);

const TRACE: Trace = {
  traceId: 'trace-abc-123',
  operation: 'upload.complete',
  category: 'fault_records',
  fileId: null,
  storage: 's3',
  startedAt: '2026-11-14T10:00:00.000Z',
  durationMs: 200,
  status: 'error',
  spans: [
    { spanId: '1', name: 'policy', startOffsetMs: 0, durationMs: 20, status: 'ok', storage: null, errorCode: null },
    { spanId: '2', name: 'storage.put', startOffsetMs: 20, durationMs: 80, status: 'error', storage: 's3', errorCode: 'STORAGE_UNAVAILABLE' },
    { spanId: '3', name: 'storage.put', startOffsetMs: 100, durationMs: 50, status: 'ok', storage: 'ftp', errorCode: null },
  ],
};

describe('TraceWaterfall (FE-05)', () => {
  const server = setupServer();
  beforeAll(async () => {
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
  });
  beforeEach(() => db.reset());

  it('is embedded in the file detail for uploadTraceId', async () => {
    login('dispecerat');
    const file = SEED_FILES.find((f) => f.category === 'fault_records' && f.integrity === 'verified')!;
    renderWithClient(<FileDetailScreen fileId={file.id} />);

    const panel = await screen.findByRole('region', { name: 'Trasarea operației' });
    const table = await within(panel).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Pas', 'Storage', 'Început', 'Durată', 'Cronologie']);
    expect(within(panel).getByText(file.uploadTraceId)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Deschide pagina trasării' })).toHaveAttribute('href', `/traces/${file.uploadTraceId}`);
  });

  it('places each bar at startOffsetMs/total and sizes it by durationMs/total; an error span says "eroare" in crimson', () => {
    render(<TraceTable trace={TRACE} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    const bar = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-bar]')!;
    expect(bar(rows[1]).style.left).toBe('10%');
    expect(bar(rows[1]).style.width).toBe('40%');
    expect(bar(rows[2]).style.left).toBe('50%');
    expect(bar(rows[2]).style.width).toBe('25%');

    expect(within(rows[1]).getByText('eroare')).toBeInTheDocument();
    expect(bar(rows[1])).toHaveClass('bg-crit');
    expect(bar(rows[2])).not.toHaveClass('bg-crit');
    expect(within(rows[2]).getByText('FTP')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Politica aplicată')).toBeInTheDocument();
  });

  it('copies the trace id and links to Grafana by trace id', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TraceActions traceId="trace-abc-123" />);
    await user.click(screen.getByRole('button', { name: 'Copiază ID-ul trasării' }));
    expect(await navigator.clipboard.readText()).toBe('trace-abc-123');
    // Without NEXT_PUBLIC_GRAFANA_URL: the Grafana served under /grafana on the same host.
    expect(screen.getByRole('link', { name: 'Deschide în Grafana' }).getAttribute('href')).toMatch(/^\/grafana\/d\/filegrid-overview\?var-trace_id=trace-abc-123&/);
    unmount();

    vi.stubEnv('NEXT_PUBLIC_GRAFANA_URL', 'https://grafana.example/');
    render(<TraceActions traceId="trace-abc-123" />);
    expect(screen.getByRole('link', { name: 'Deschide în Grafana' }).getAttribute('href')).toMatch(/^https:\/\/grafana\.example\/d\/filegrid-overview\?var-trace_id=trace-abc-123&/);
  });
});
