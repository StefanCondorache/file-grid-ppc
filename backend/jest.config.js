// One embedded Postgres for the whole run (test/global-setup.ts); test files share it,
// so they run one at a time and every test file starts from a truncated database.
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  maxWorkers: 1,
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/storage/**', '!src/crypto/**'],
  coverageDirectory: './coverage',
};
