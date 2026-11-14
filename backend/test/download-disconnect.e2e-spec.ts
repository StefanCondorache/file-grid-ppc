import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { browser, createTestApp, loginCookie, memoryStorages, resetDatabase } from './helpers';

const MiB = 1024 * 1024;

/** A client that leaves in the middle of a large (streamed) download must release the storage read. */
describe('download interrupted by the client', () => {
  let app: NestExpressApplication;
  let storages: ReturnType<typeof memoryStorages>;

  beforeAll(async () => {
    await resetDatabase();
    storages = memoryStorages();
    app = await createTestApp({ storage: storages.registry });
    await new Promise<void>((resolve) => app.getHttpServer().listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await app.close();
  });

  it('closes the storage stream when the client disconnects', async () => {
    const admin = await loginCookie(app);
    const file = Buffer.alloc(9 * MiB, 7);
    const created = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'mare.bin',
        fileSize: file.length,
        mimeType: 'application/octet-stream',
        metadata: {
          kind: 'fault',
          zone: 'banat',
          substation: 'S1',
          eventTime: '2026-11-14T10:00:00Z',
          severity: 'low',
        },
      });
    const { uploadId, chunkSize, partCount } = created.body;
    for (let part = 1; part <= partCount; part += 1) {
      await request(app.getHttpServer())
        .put(`/api/v1/uploads/${uploadId}/parts/${part}`)
        .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
        .send(file.subarray((part - 1) * chunkSize, part * chunkSize));
    }
    const done = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set(browser(admin))
      .send({ sha256: createHash('sha256').update(file).digest('hex'), partCount });
    expect(done.body.verdict).toBe('match');
    const s3 = storages.adapter('s3');
    s3.setDelayMs(20); // slow storage: the client leaves while the server waits for the next chunk

    const { port } = app.getHttpServer().address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/files/${done.body.fileId}/content`,
          headers: { Cookie: admin },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.setTimeout(5000, () => reject(new Error('no data')));
      req.end();
    });

    const deadline = Date.now() + 3000;
    while (s3.openReads > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(s3.openReads).toBe(0);
    s3.setDelayMs(0);
  });
});
