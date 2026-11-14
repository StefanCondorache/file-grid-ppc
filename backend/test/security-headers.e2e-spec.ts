import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CSRF_HEADER } from './constants';
import {
  binary,
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
} from './helpers';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Headers every API answer carries; HSTS comes from Traefik, not from here. */
function expectDefensive(response: request.Response): void {
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
}

describe('defensive response headers', () => {
  let app: NestExpressApplication;
  let admin: string;
  let fileId: string;
  const file = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) & 0xff));
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ storage: memoryStorages().registry });
    admin = await loginCookie(app);
    const created = await request(server())
      .post('/api/v1/uploads')
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'avarie.pdf',
        fileSize: file.length,
        mimeType: 'application/pdf',
        metadata: {
          kind: 'fault',
          zone: 'banat',
          substation: 'Stația Timișoara Nord',
          eventTime: '2026-11-14T10:00:00Z',
          severity: 'high',
        },
      });
    const { uploadId } = created.body;
    await request(server())
      .put(`/api/v1/uploads/${uploadId}/parts/1`)
      .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
      .send(file);
    const done = await request(server())
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set(browser(admin))
      .send({ sha256: sha256(file), partCount: 1 });
    expect(done.status).toBe(200);
    fileId = done.body.fileId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks the login answer (it sets the session cookie) as not storable', async () => {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .set(CSRF_HEADER)
      .send({ username: 'admin', password: 'wrong-password-123' });

    expect(response.status).toBe(401);
    expectDefensive(response);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['/auth/me', '/files', '/policies', '/guarantees'])(
    'sends nosniff, no-referrer and no-store with GET %s',
    async (path) => {
      const response = await request(server()).get(`/api/v1${path}`).set(browser(admin));

      expect(response.status).toBe(200);
      expectDefensive(response);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('sends them with file metadata and with error envelopes', async () => {
    const metadata = await request(server()).get(`/api/v1/files/${fileId}`).set(browser(admin));
    const missing = await request(server()).get('/api/v1/nothing-here').set(browser(admin));
    const unauthenticated = await request(server()).get('/api/v1/auth/me');

    for (const response of [metadata, missing, unauthenticated]) {
      expectDefensive(response);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(metadata.status).toBe(200);
  });

  it('keeps ETag, Range and If-Range working on file content', async () => {
    const whole = await binary(
      request(server()).get(`/api/v1/files/${fileId}/content`).set(browser(admin)),
    );
    const etag = whole.headers.etag as string;
    const ranged = await binary(
      request(server())
        .get(`/api/v1/files/${fileId}/content`)
        .set({ ...browser(admin), Range: 'bytes=10-19', 'If-Range': etag }),
    );
    const stale = await binary(
      request(server())
        .get(`/api/v1/files/${fileId}/content`)
        .set({ ...browser(admin), Range: 'bytes=10-19', 'If-Range': '"stale"' }),
    );

    expect(whole.status).toBe(200);
    expect(etag).toBe(`"${sha256(file)}"`);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expectDefensive(whole);
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 10-19/4000');
    expect((ranged.body as Buffer).equals(file.subarray(10, 20))).toBe(true);
    expect(stale.status).toBe(200);
  });

  it('sends nosniff and no-referrer with the probes too', async () => {
    expectDefensive(await request(server()).get('/healthz'));
    expectDefensive(await request(server()).get('/readyz'));
  });
});
