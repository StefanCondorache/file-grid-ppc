import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { browser, createTestApp, loginCookie, memoryStorages, resetDatabase } from './helpers';

describe('demo status', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ storage: memoryStorages().registry });
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows each storage state without the probe detail, which can name the bucket or a host', async () => {
    const admin = await loginCookie(app);

    const status = await request(app.getHttpServer())
      .get('/api/v1/demo/status')
      .set(browser(admin));

    expect(status.status).toBe(200);
    for (const storage of ['s3', 'ftp', 'db']) {
      expect(Object.keys(status.body.storages[storage]).sort()).toEqual([
        'circuit',
        'lastCheckAt',
        'latencyMs',
        'up',
      ]);
    }
  });
});
