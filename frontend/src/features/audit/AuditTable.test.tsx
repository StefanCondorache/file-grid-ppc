import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Me, Role } from '@/lib/api/types';
import { FALLBACK_MATRIX } from '@/lib/auth/capabilities';
import { renderWithClient } from '@/test/render';
import { AUDIT_SEED } from '@/mocks/seed/audit';
import { AuditScreen } from './AuditScreen';
import { AuditTable } from './AuditTable';
import { filtersFromParams, filtersToParams } from './url';

vi.mock('next/navigation', () => ({
  usePathname: () => '/audit',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const meFor = (role: Role): Me => ({
  user: { id: `u-${role}`, username: role, displayName: role, role },
  realUser: { id: `u-${role}`, username: role, displayName: role, role },
  activeRole: role, roles: [role], capabilities: FALLBACK_MATRIX[role], demoMode: true,
  actingRoleExpiresAt: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), serverTime: new Date().toISOString(),
});

describe('AuditTable', () => {
  it('shows the cine / ce / când / motiv / ID urmărire columns and links the trace', () => {
    renderWithClient(<AuditTable events={AUDIT_SEED} />);
    for (const name of ['Cine', 'Ce', 'Când', 'Motiv', 'Rezultat', 'ID urmărire']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const reveal = AUDIT_SEED.find((e) => e.action === 'reveal_pii' && !e.actingAs)!;
    expect(screen.getByRole('link', { name: reveal.traceId })).toHaveAttribute('href', `/traces/${reveal.traceId}`);
    expect(screen.getByText(reveal.reason!)).toBeInTheDocument();
  });

  it('marks role-switcher events with "Rol demo"', () => {
    const switched = AUDIT_SEED.filter((e) => e.actingAs);
    renderWithClient(<AuditTable events={switched} />);
    const rows = screen.getAllByRole('row').slice(1);
    for (const row of rows) expect(within(row).getByText(/Rol demo/)).toBeInTheDocument();
  });
});

describe('audit filters in the URL', () => {
  it('round-trips through URLSearchParams and drops empty values', () => {
    const f = filtersFromParams(new URLSearchParams('action=reveal_pii&fileId=f-con-0412&from=2026-11-01&page=2&x=1'));
    expect(f).toEqual({ action: 'reveal_pii', fileId: 'f-con-0412', from: '2026-11-01', page: 2 });
    expect(filtersToParams(f).toString()).toBe('action=reveal_pii&fileId=f-con-0412&from=2026-11-01&page=2');
  });
});

describe('AuditScreen', () => {
  it('is forbidden for teren without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderWithClient(<AuditScreen me={meFor('teren')} />);
    expect(screen.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeInTheDocument();
    expect(screen.getByText(/jurnalul de audit/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
