import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the installed Microsoft Edge (Chromium) so no browser download is needed.
    channel: 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_MOCKS: '1' },
  },
});
