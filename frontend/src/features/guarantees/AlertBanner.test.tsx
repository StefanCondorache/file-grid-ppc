import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnnouncements, resetAnnouncer } from '@/lib/a11y/announcer';
import { makeQueryClient } from '@/lib/api/query-client';
import { qk } from '@/lib/api/query-keys';
import type { GuaranteeState, GuaranteeStatus } from '@/lib/monitoring/contract';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { scenario } from '@/mocks/scenario';
import { SEED_USERS } from '@/mocks/seed/auth';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { AlertBanner } from './AlertBanner';
import { GuaranteeCard } from './GuaranteeCard';

const clock = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit' });

/** The always-present slot under the top bar; its row animates 0fr → 1fr, so content never jumps in. */
const slot = () => document.querySelector<HTMLElement>('[data-alert-banner]')!;

/** A 10× fault storm, held for 3 ticks: the fault guarantee turns at_risk and an alert is raised. */
function storm() {
  scenario.startStorm('fault_records', 10, 120);
  for (let i = 0; i < 3; i += 1) scenario.tick();
}

describe('AlertBanner (mock API)', () => {
  const server = setupServer();
  let base: Awaited<ReturnType<typeof buildHandlers>> = [];
  beforeAll(async () => {
    base = await buildHandlers(['auth', 'monitoring']);
    server.resetHandlers(...base);
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterAll(() => server.close());
  beforeEach(() => {
    db.reset();
    scenario.reset();
    resetAnnouncer();
    startSession(SEED_USERS.find((u) => u.role === 'dispecerat')!);
  });
  afterEach(() => {
    server.resetHandlers(...base);
    scenario.stop();
  });

  it('stays collapsed while every guarantee is OK, in a slot that keeps its grid-template-rows', async () => {
    const { client } = renderWithClient(<AlertBanner />);
    await waitFor(() => expect(client.getQueryData(qk.guarantees)).toBeDefined());
    expect(slot()).toHaveClass('grid', 'grid-rows-[0fr]');
    expect(slot()).toHaveAttribute('data-open', 'false');
    expect(screen.queryByRole('region', { name: 'Alerte active' })).toBeNull();
  });

  it('appears when a guarantee is not OK, naming the guarantee and its cause, with "Vezi detalii" to /', async () => {
    const { client } = renderWithClient(<AlertBanner />);
    await waitFor(() => expect(client.getQueryData(qk.guarantees)).toBeDefined());
    const before = slot();

    storm();
    // What the live bridge does with a guarantees.status event.
    act(() => void client.setQueryData(qk.guarantees, { data: scenario.guarantees() }));

    const region = await screen.findByRole('region', { name: 'Alerte active' });
    expect(slot()).toBe(before);
    expect(slot()).toHaveClass('grid-rows-[1fr]');
    expect(slot()).toHaveAttribute('data-open', 'true');
    expect(slot()).toHaveAttribute('data-tone', 'warn');
    // No live role of its own (A11Y-16): the announcer speaks it.
    expect(slot().querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull();

    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const chip = within(items[0]!).getByText('În pericol').closest('[data-tone]');
    expect(chip).toHaveAttribute('data-tone', 'warn');
    expect(chip?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(items[0]!.textContent).toMatch(/Avarii: Avariile ajung la dispecerat în \d+(,\d)? s, peste ținta de 2 s\./);
    expect(within(region).getByRole('link', { name: 'Vezi detalii' })).toHaveAttribute('href', '/');
  });

  it('turns crimson when a guarantee is violated', async () => {
    scenario.startStorm('fault_records', 20, 120);
    for (let i = 0; i < 6; i += 1) scenario.tick();
    expect(scenario.guarantees().find((g) => g.category === 'fault_records')?.state).toBe('violated');
    renderWithClient(<AlertBanner />);
    const region = await screen.findByRole('region', { name: 'Alerte active' });
    expect(slot()).toHaveAttribute('data-tone', 'crit');
    expect(within(region).getByText('Încălcat').closest('[data-tone]')).toHaveAttribute('data-tone', 'crit');
  });

  it('acknowledges the alert and records who and when', async () => {
    storm();
    const user = userEvent.setup();
    renderWithClient(<AlertBanner />);
    const region = await screen.findByRole('region', { name: 'Alerte active' });

    await user.click(await within(region).findByRole('button', { name: 'Confirmă alerta Avarii' }));

    const done = await within(region).findByText(/^Confirmată de Elena Marin la \d{2}:\d{2}$/);
    expect(within(region).queryByRole('button', { name: /Confirmă/ })).toBeNull();
    expect(done).toHaveFocus();
    const [alert] = scenario.alerts('active');
    expect(alert?.acknowledgedBy).toMatchObject({ username: 'dispecerat', displayName: 'Elena Marin' });
    expect(done.textContent).toBe(`Confirmată de Elena Marin la ${clock.format(new Date(alert!.acknowledgedAt!))}`);
    expect(db.list<{ action: string }>('audit').filter((e) => e.action === 'alert_ack')).toHaveLength(1);
    // The guarantee is still at risk, so the banner stays.
    expect(slot()).toHaveAttribute('data-open', 'true');
  });
});

describe('AlertBanner announcements', () => {
  function fault(state: GuaranteeState): GuaranteeStatus {
    const p95Ms = { ok: 600, at_risk: 3400, violated: 4600 }[state];
    return {
      category: 'fault_records',
      state,
      causeCode: state === 'ok' ? null : 'FAULT_P95_ABOVE_TARGET',
      causeFacts: state === 'ok' ? {} : { p95Ms, targetMs: 2000, samples: 412, windowMinutes: 1 },
      metrics: [{ key: 'uploadToAvailableP95Ms', value: String(p95Ms), unit: 'ms', threshold: '2000', comparator: 'lte' }],
      updatedAt: '2026-11-14T13:33:00.000Z',
    };
  }

  /** A client that already holds the data and never refetches it: the test drives the cache like the live bridge. */
  function setup(initial: GuaranteeState, withCard = false) {
    const client = makeQueryClient();
    client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
    client.setQueryData(qk.guarantees, { data: [fault(initial)] });
    client.setQueryData(qk.alerts, { data: [] });
    const Card = () => {
      const g = (client.getQueryData(qk.guarantees) as { data: GuaranteeStatus[] }).data[0]!;
      return <GuaranteeCard guarantee={g} />;
    };
    const view = render(
      <QueryClientProvider client={client}>
        <AlertBanner />
        {withCard && <Card />}
      </QueryClientProvider>,
    );
    const set = (state: GuaranteeState) =>
      act(() => {
        client.setQueryData(qk.guarantees, { data: [fault(state)] });
        vi.advanceTimersByTime(0);
        if (withCard) view.rerender(<QueryClientProvider client={client}><AlertBanner /><Card /></QueryClientProvider>);
      });
    return { set };
  }

  const spoken = () => getAnnouncements().polite.count + getAnnouncements().assertive.count;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncer();
  });
  afterEach(() => vi.useRealTimers());

  it('is silent on load, then speaks a change once: politely for În pericol, assertively for Încălcat', () => {
    const { set } = setup('at_risk');
    act(() => vi.advanceTimersByTime(5_000));
    expect(spoken()).toBe(0);

    set('violated');
    act(() => vi.advanceTimersByTime(3_000));
    expect(getAnnouncements().assertive).toEqual({ text: 'Garanția Avarii: Încălcat', count: 1 });

    set('at_risk');
    act(() => vi.advanceTimersByTime(3_000));
    expect(getAnnouncements().polite).toEqual({ text: 'Garanția Avarii: În pericol', count: 1 });

    set('ok');
    act(() => vi.advanceTimersByTime(3_000));
    expect(getAnnouncements().polite).toEqual({ text: 'Garanția Avarii: OK', count: 2 });
  });

  it('debounces flapping by 3 s and merges with the card, so one change is said once', () => {
    const { set } = setup('ok', true);
    set('at_risk');
    act(() => vi.advanceTimersByTime(1_000));
    set('ok');
    act(() => vi.advanceTimersByTime(5_000));
    expect(spoken()).toBe(0);

    set('at_risk');
    act(() => vi.advanceTimersByTime(3_000));
    expect(getAnnouncements().polite).toEqual({ text: 'Garanția Avarii: În pericol', count: 1 });
  });
});
