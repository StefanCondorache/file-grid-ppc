import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuditTable, type AuditRow } from './AuditTable';

const base: AuditRow = {
  id: 'a1', at: '2026-11-14T10:00:00.000Z', actor: { id: 'u1', username: 'admin', displayName: 'Administrator', role: 'admin' },
  actingAs: null, demo: false, action: 'upload', outcome: 'success', fileId: 'f1', fileDisplayName: 'releu.pdf', reason: null, details: null, traceId: 'trace-123', clientIp: '10.0.0.7',
};

describe('AuditTable', () => {
  it('shows the five columns, trace ID and client IP', () => {
    render(<AuditTable events={[base]} />);
    for (const h of ['Cine', 'Ce', 'Când', 'Motiv', 'ID urmărire']) expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(screen.getByText('trace-123')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.7')).toBeInTheDocument();
    expect(screen.getByText('Încărcare')).toBeInTheDocument();
  });

  it('marks acting-as events with "Rol demo" and shows the reason', () => {
    const e: AuditRow = { ...base, id: 'a2', action: 'reveal_pii', actingAs: 'auditor', reason: 'Control reclamație' };
    render(<AuditTable events={[e]} />);
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText(/Rol demo/)).toBeInTheDocument();
    expect(within(row).getByText('Control reclamație')).toBeInTheDocument();
  });

  it('shows no demo tag without actingAs', () => {
    render(<AuditTable events={[base]} />);
    expect(screen.queryByText(/Rol demo/)).toBeNull();
  });
});
