import { describe, expect, it } from 'vitest';
import type { Me } from '@/lib/api/types';
import { can } from './capabilities';
import { safeNext } from './safe-next';

const me = (role: Me['activeRole'], capabilities: Me['capabilities'] = []): Me =>
  ({ activeRole: role, capabilities } as unknown as Me);

describe('can', () => {
  it('uses the capabilities the backend sends', () => {
    expect(can(me('auditor', ['reveal_pii']), 'reveal_pii')).toBe(true);
    expect(can(me('auditor', ['view_audit']), 'reveal_pii')).toBe(false);
  });

  it('falls back to the FE-01 matrix only when the list is empty', () => {
    expect(can(me('racordari'), 'view_connection')).toBe(true);
    expect(can(me('racordari'), 'reveal_pii')).toBe(false);
    expect(can(me('admin'), 'reveal_pii')).toBe(false);
    expect(can(me('admin'), 'edit_policies')).toBe(true);
    expect(can(undefined, 'view_fault')).toBe(false);
  });
});

describe('safeNext', () => {
  it('keeps same-site relative paths', () => {
    expect(safeNext('/files?category=fault')).toBe('/files?category=fault');
  });
  it('rejects anything that could leave the site', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', 'javascript:alert(1)', '', null]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});
