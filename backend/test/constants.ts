// Fake credentials used only by the test suite.
export const TEST_JWT_SECRET = 'test-jwt-secret-0123456789-0123456789-abcdef';
export const TEST_ADMIN_PASSWORD = 'admin-test-password-1';
export const TEST_OPERATOR_PASSWORD = 'operator-test-password-1';
export const TEST_METER_KEY = 'meter-test-key-0123456789abcdef';

// The policy rows migration 0001 seeds, written out by hand: tests that change policies
// get them back before the next test file.
export const SEED_POLICIES = [
  ['meter_reading', 'db', 's3', false, 1_048_576, 16],
  ['fault_record', 's3', 'db', false, 4_194_304, 8],
  ['connection_doc', 's3', 'db', true, 2_097_152, 4],
  ['drone_video', 'ftp', 's3', false, 8_388_608, 4],
] as const;
