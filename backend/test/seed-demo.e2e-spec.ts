import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { browser, createTestApp, loginCookie, memoryStorages, resetDatabase } from './helpers';
import { listen } from './sse';

const SCRIPT = join(__dirname, '..', 'scripts', 'seed-demo.ts');

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs the real CLI against the test app; resolves with its exit code and output. */
function seed(url: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { PATH: process.env.PATH, FILEGRID_URL: url }, timeout: 100_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

describe('scripts/seed-demo.ts: realistic demo data, uploaded through the API', () => {
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

  it('uploads faults in three zones, connection documents and videos once, then nothing more', async () => {
    const first = await seed(url);
    expect(first).toEqual({ code: 0, out: expect.stringContaining('done:') });

    const admin = await loginCookie(app);
    const total = async (category: string) =>
      (
        await request(app.getHttpServer())
          .get(`/api/v1/files?category=${category}&q=seed&pageSize=1`)
          .set(browser(admin))
      ).body.meta.total;
    expect(await total('fault_records')).toBe(60);
    expect(await total('connection_documents')).toBe(20);
    expect(await total('drone_videos')).toBe(hasFfmpeg() ? 4 : 0);

    const grid = await request(app.getHttpServer())
      .get('/api/v1/statistics/grid-insights')
      .set(browser(admin));
    const byZone: { zone: string; count: number }[] = grid.body.faultsByZone;
    expect(byZone.map((z) => z.zone).sort()).toEqual(['banat', 'dobrogea', 'muntenia']);
    expect(new Set(byZone.map((z) => z.count)).size).toBe(3);

    const documents = await request(app.getHttpServer())
      .get('/api/v1/files?category=connection_documents&q=seed&pageSize=1')
      .set(browser(admin));
    const document = documents.body.data[0];
    expect(document.encryptedAtRest).toBe(true);
    expect(document.uploadedBy?.username).toBe('racordari');
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/files/${document.id}`)
      .set(browser(admin));
    expect(detail.body.metadata.cnpMasked).toMatch(/^\d\*+\d{3}$/);

    const again = await seed(url);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/0 uploaded/);
    expect(await total('fault_records')).toBe(60);
  }, 120_000);
});
