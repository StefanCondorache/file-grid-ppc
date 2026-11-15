import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// E2E_PORT=3000 reuses a `next dev` you already run (Next 16 allows one dev server per project).
const PORT = Number(process.env.E2E_PORT ?? 3100);
// E2E_BASE_URL=https://ppc.filegrid.cc.cd runs against a real stack: no dev server, no mocks.
const BASE_URL = process.env.E2E_BASE_URL;
// E2E_BROWSER=/usr/bin/chromium uses that browser instead of the installed Microsoft Edge.
const BROWSER = process.env.E2E_BROWSER;

export default defineConfig({
  testDir: 'tests/e2e',
  // Outside the project: Next dev watches the tree and would rebuild/reload on every trace write.
  outputDir: process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), 'filegrid-playwright'),
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL ?? `http://localhost:${PORT}`,
    // Microsoft Edge (Chromium) by default, so no browser download is needed.
    ...(BROWSER ? { launchOptions: { executablePath: BROWSER } } : { channel: 'msedge' }),
    trace: 'retain-on-failure',
    // E2E_VIDEO=on records every test at 1440x900 (the backup video of the demo rehearsal).
    ...(process.env.E2E_VIDEO === 'on'
      ? { video: { mode: 'on', size: { width: 1440, height: 900 } }, viewport: { width: 1440, height: 900 } }
      : {}),
  },
  webServer: BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `http://localhost:${PORT}/healthz`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { NEXT_PUBLIC_API_MOCKS: '1' },
      },
});
