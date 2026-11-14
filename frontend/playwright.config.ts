import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// E2E_PORT=3000 reuses a `next dev` you already run (Next 16 allows one dev server per project).
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'tests/e2e',
  // Outside the project: Next dev watches the tree and would rebuild/reload on every trace write.
  outputDir: join(tmpdir(), 'filegrid-playwright'),
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
