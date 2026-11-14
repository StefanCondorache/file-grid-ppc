import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, memoryStorages, resetDatabase } from './helpers';
import { listen } from './sse';

const SCRIPT = join(__dirname, '..', 'scripts', 'proof-1gb-upload.ts');
/** Stands in for `kubectl top pod`: two backend pods, name first and `<n>Mi`. */
const FAKE_TOP = "printf 'filegrid-backend-a 3m 90Mi\\nfilegrid-backend-b 2m 95Mi\\n'";

function proof(url: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { PATH: process.env.PATH, FILEGRID_URL: url, ...env }, timeout: 100_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

describe('scripts/proof-1gb-upload.ts: a large upload round trip with the backend memory', () => {
  let app: NestExpressApplication;
  let url: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({
      storage: memoryStorages().registry,
      env: { FILEGRID_PASSWORDLESS_LOGIN: 'true' },
    });
    url = await listen(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('uploads in parts, downloads, matches the SHA-256 and reports the memory per pod', async () => {
    const run = await proof(url, {
      PROOF_SIZE_MIB: '40',
      PROOF_SAMPLE_S: '1',
      PROOF_MEMORY_CMD: FAKE_TOP,
    });

    expect(run).toEqual({ code: 0, out: expect.stringContaining('SHA-256 match') });
    expect(run.out).toContain('| 40 MiB | 3 x 16 MiB |');
    expect(run.out).toMatch(/\| filegrid-backend-a \| 90 \| 90 \| 90 \| 90 \| 0 \| yes \|/);
    expect(run.out).toMatch(/\| filegrid-backend-b \| 95 \|/);
  }, 120_000);

  it('fails clearly when it cannot log in', async () => {
    const run = await proof('http://127.0.0.1:9', { PROOF_SIZE_MIB: '1' });

    expect(run.code).toBe(1);
    expect(run.out).toContain('proof failed:');
  }, 30_000);
});
