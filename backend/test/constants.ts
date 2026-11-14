// Fake credentials used only by the test suite.
export const TEST_JWT_SECRET = 'test-jwt-secret-0123456789-0123456789-abcdef';
export const TEST_ADMIN_PASSWORD = 'admin-test-password-1';
export const TEST_METER_KEY = 'meter-test-key-0123456789abcdef';
// base64 of 32 bytes 0x01..0x20: a fixed KEK for tests only.
export const TEST_KEK = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
export const CSRF_HEADER = { 'X-Requested-With': 'filegrid' } as const;
