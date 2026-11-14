import { act, render, screen, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Announcer } from '@/components/a11y/Announcer';
import { LiveBridge } from '@/features/shell/LiveBridge';
import { resetAnnouncer } from '@/lib/a11y/announcer';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { SEED_FILES, type MockFileRow } from '@/mocks/seed/files';
import { startSession } from '@/mocks/session';
import { useAppStore } from '@/stores/app-store';
import { renderWithClient } from '@/test/render';
import { FilesScreen } from './FilesScreen';
import { FilesTable } from './FilesTable';
import type { FileItem } from './queries';

/** The URL as real state, read through `useSearchParams()` (as in FilesTable.test.tsx). */
const nav = vi.hoisted(() => {
  let params = new URLSearchParams();
  const listeners = new Set<() => void>();
  return {
    params: () => params,
    go(next: string) {
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

/**
 * The mock stream as the browser sees it: an EventSource fed by the mock scenario, the clock behind the MSW
 * `GET /stream` handler (jsdom has no EventSource, so the `sse()` handler cannot run here).
 */
class ScenarioEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly off: () => void;

  constructor(readonly url: string) {
    super();
    this.off = scenario.on((e) => {
      if (this.readyState === 1) this.dispatchEvent(new MessageEvent(e.type, { data: JSON.stringify(e.data), lastEventId: String(e.id) }));
    });
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  close() {
    this.readyState = ScenarioEventSource.CLOSED;
    this.off();
  }
}

/** 17:41:07 in Bucharest, twenty minutes after the newest seeded fault (15:20:33Z). */
const NOW = new Date('2026-11-14T15:41:07.000Z');
const NEW_ID = '00000000-0000-4000-8000-000000000412';
const NEW_NAME = 'Avarie_PT_Medgidia_0412.pdf';

/** A fault the uploads mock would have stored 4 s ago, in the shape of the mock `files` collection. */
function storedFault(): MockFileRow {
  const base = SEED_FILES.find((f) => f.category === 'fault_records')!;
  const createdAt = new Date(NOW.getTime() - 4_000).toISOString();
  return {
    ...structuredClone(base),
    id: NEW_ID,
    displayName: NEW_NAME,
    createdAt,
    availableAt: createdAt,
    uploadedBy: 'teren',
    zone: 'dobrogea',
    origin: 'manual',
    integrity: 'verified',
    storage: 's3',
    usedFallback: false,
    metadata: { kind: 'fault', zone: 'dobrogea', substation: 'PT Medgidia 4', eventTime: createdAt, severity: 'critical' },
  };
}

const bodyRows = () => screen.getAllByRole('row').slice(1);

describe('live fault list', () => {
  const server = setupServer();
  beforeAll(async () => {
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.listen({ onUnhandledRequest: 'bypass' });
    vi.stubGlobal('EventSource', ScenarioEventSource);
  });
  afterAll(() => {
    server.close();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    // Only the wall clock is frozen; timers, MSW and the stream run for real.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    db.reset();
    resetAnnouncer();
    nav.go('/files?category=fault');
    useAppStore.setState({ live: 'connecting', livePaused: false });
    startSession(SEED_USERS.find((u) => u.username === 'dispecerat')!);
  });
  afterEach(() => {
    server.resetHandlers();
    vi.useRealTimers();
  });

  it('puts a fault from the stream on top within 1 s, without moving keyboard focus, marked "Nou · acum 4 s", then announces it', async () => {
    renderWithClient(
      <>
        <Announcer />
        <LiveBridge />
        <FilesScreen />
      </>,
    );
    expect(await screen.findByText('Avarie_Reșița_PT_21.pdf')).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().live).toBe('open'));
    expect(screen.queryByText(/^Nou ·/)).toBeNull();

    // The dispatcher is working in the table: focus sits on the "Încărcat" sort header, just above the new row.
    const focused = screen.getByRole('button', { name: /Încărcat/ });
    focused.focus();
    expect(focused).toHaveFocus();

    // The upload is stored, then the server announces it on the stream (backend upload-assembler.ts payload).
    const stored = db.insert('files', storedFault());
    const sentAt = performance.now();
    act(() => {
      scenario.emit('file.created', {
        fileId: stored.id, category: 'fault_records', zone: 'dobrogea', severity: 'critical', substation: 'PT Medgidia 4',
        origin: 'manual', createdAt: stored.createdAt, availableAt: stored.availableAt,
      });
    });

    await waitFor(() => expect(within(bodyRows()[0]!).getByText(NEW_NAME)).toBeInTheDocument(), { timeout: 1_000 });
    expect(performance.now() - sentAt).toBeLessThan(1_000);
    expect(focused).toHaveFocus();
    expect(within(bodyRows()[1]!).getByText('Avarie_Reșița_PT_21.pdf')).toBeInTheDocument();

    const top = bodyRows()[0]!;
    expect(within(top).getByText('Nou · acum 4 s')).toBeInTheDocument();
    expect(top).toHaveAttribute('data-new', 'true');
    expect(top.className).toContain('bg-info-tint');
    // Only the live row is marked.
    expect(screen.getAllByText(/^Nou ·/)).toHaveLength(1);
    expect(bodyRows()[1]).not.toHaveAttribute('data-new');

    // SC-04: screen readers hear the new fault politely, once the 5 s storm-coalescing window closes.
    const polite = screen.getByRole('status');
    expect(polite).toHaveTextContent('');
    await waitFor(() => expect(polite).toHaveTextContent('Avarie nouă: Dobrogea, PT Medgidia 4'), { timeout: 6_000 });
  }, 10_000);
});

const fault = (over: Partial<FileItem> = {}): FileItem => ({
  id: NEW_ID,
  displayName: NEW_NAME,
  category: 'fault_records',
  size: 5_347_737,
  mimeType: 'application/pdf',
  createdAt: new Date(NOW.getTime() - 4_000).toISOString(),
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

describe('new-row marker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useAppStore.setState({ livePaused: false });
  });
  afterEach(() => vi.useRealTimers());

  it('counts up each second, then washes the row back to the surface after a minute', () => {
    render(<FilesTable category="fault_records" sort="-createdAt" onSort={vi.fn()} rows={[fault()]} />);
    const row = bodyRows()[0]!;
    expect(within(row).getByText('Nou · acum 4 s')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    expect(within(row).getByText('Nou · acum 5 s')).toBeInTheDocument();

    // The wash is a colour transition on the motion token (0 ms under reduced motion).
    expect(row.className).toContain('transition-colors');
    expect(row.className).toContain('duration-(--fg-dur-fast)');
    act(() => vi.advanceTimersByTime(55_000));
    expect(within(row).queryByText(/^Nou ·/)).toBeNull();
    expect(row).not.toHaveAttribute('data-new');
    expect(row.className).not.toContain('bg-info-tint');
  });

  it('freezes while "Actualizări live" is paused and marks only faults', () => {
    useAppStore.setState({ livePaused: true });
    render(
      <FilesTable
        sort="-createdAt"
        onSort={vi.fn()}
        rows={[fault(), fault({ id: '00000000-0000-4000-8000-000000000413', displayName: 'Citiri contoare 15:41:05', category: 'meter_readings', origin: 'simulator' })]}
      />,
    );
    const [faultRow, meterRow] = bodyRows();
    act(() => vi.advanceTimersByTime(3_000));
    expect(within(faultRow!).getByText('Nou · acum 4 s')).toBeInTheDocument();
    expect(meterRow).not.toHaveAttribute('data-new');
    expect(within(meterRow!).queryByText(/^Nou ·/)).toBeNull();

    act(() => useAppStore.setState({ livePaused: false }));
    expect(within(faultRow!).getByText('Nou · acum 7 s')).toBeInTheDocument();
  });
});
