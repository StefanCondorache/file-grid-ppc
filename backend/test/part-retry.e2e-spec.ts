import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { browser, createTestApp, loginCookie, memoryStorages, resetDatabase } from './helpers';
import { listen, sleep } from './sse';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe('a part sent again (the client retries after a lost answer)', () => {
  let app: NestExpressApplication;
  let url: string;
  let admin: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ storage: memoryStorages().registry });
    url = await listen(app);
    admin = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is answered alreadyReceived only after its whole body has been read', async () => {
    const part = Buffer.alloc(64 * 1024, 7);
    const created = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'test-retry.pdf',
        fileSize: part.length,
        mimeType: 'application/pdf',
        metadata: {
          kind: 'fault',
          zone: 'banat',
          substation: 'Stația Test',
          eventTime: '2026-11-14T10:00:00Z',
          severity: 'low',
        },
      });
    const path = `/api/v1/uploads/${created.body.uploadId}/parts/1`;
    const headers = {
      ...browser(admin),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(part.length),
      'X-Part-SHA256': sha256(part),
    };
    const first = await request(app.getHttpServer()).put(path).set(headers).send(part);
    expect(first.body.alreadyReceived).toBe(false);

    // The retry: half the body, a pause, then the rest. No answer may come in the pause.
    const events: string[] = [];
    const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const retry = httpRequest(`${url}${path}`, { method: 'PUT', headers }, (response) => {
        events.push('answer');
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      retry.on('error', reject);
      retry.write(part.subarray(0, part.length / 2));
      void sleep(300).then(() => {
        events.push('rest sent');
        retry.end(part.subarray(part.length / 2));
      });
    });
    const retried = await answer;

    expect(events).toEqual(['rest sent', 'answer']);
    expect(retried.status).toBe(200);
    expect(JSON.parse(retried.body)).toMatchObject({ partNumber: 1, alreadyReceived: true });
  });
});
