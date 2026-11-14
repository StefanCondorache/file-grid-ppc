import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './db';

describe('mock db', () => {
  beforeEach(() => window.localStorage.clear());

  it('persists across a simulated reload', () => {
    createDb(window.localStorage).storage.set('S3', 'down');
    expect(createDb(window.localStorage).storage.status('S3')).toBe('down');
  });

  it('append-only audit keeps order', () => {
    const db = createDb(window.localStorage);
    db.audit.append({ action: 'login' });
    db.audit.append({ action: 'role_switch' });
    expect(db.list<{ action: string }>('audit').map((e) => e.action)).toEqual(['login', 'role_switch']);
  });

  it('reset restores seeds', () => {
    const db = createDb(window.localStorage);
    db.register('things', [{ id: 'a' }]);
    db.insert('things', { id: 'b' });
    db.reset();
    expect(db.list('things')).toEqual([{ id: 'a' }]);
    expect(db.policies.get('fault')).toMatchObject({ version: 3, primaryStorage: 'S3', fallbackStorage: 'FTP' });
  });
});
