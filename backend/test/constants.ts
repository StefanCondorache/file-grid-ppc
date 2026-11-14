import { randomBytes } from 'node:crypto';

/**
 * Test credentials are generated at random for every test run: no password, key or secret is
 * written in the repository, not even a fake one.
 */
export function fakeSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export const TEST_JWT_SECRET = fakeSecret(32);
export const TEST_ADMIN_PASSWORD = fakeSecret(15);
export const TEST_METER_KEY = fakeSecret(24);
export const TEST_KEK = randomBytes(32).toString('base64');
export const CSRF_HEADER = { 'X-Requested-With': 'filegrid' } as const;
