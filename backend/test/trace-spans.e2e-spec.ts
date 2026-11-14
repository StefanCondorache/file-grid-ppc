import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  binary,
  browser,
  createTestApp,
  createUser,
  loginCookie,
  memoryStorages,
  resetDatabase,
} from './helpers';

const MiB = 1024 * 1024;
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const FAULT_METADATA = {
  kind: 'fault',
  zone: 'banat',
  substation: 'Stația Timișoara Nord',
  eventTime: '2026-11-14T10:00:00Z',
  severity: 'high',
};
const CONNECTION_METADATA = {
  kind: 'connection',
  requestNumber: 'RC-2026-0042',
  documentType: 'cerere',
  applicantName: 'Ion Popescu',
  cnp: '1960101123456',
};

interface SpanView {
  name: string;
  startOffsetMs: number;
  durationMs: number;
  status: string;
  attributes: Record<string, unknown>;
}

describe('traces: every step of one operation, from the request to the storage', () => {
  let app: NestExpressApplication;
  let admin: string;
  const server = () => app.getHttpServer();

  /** Create, send every part (each one traced), complete; returns the part and complete answers. */
  async function upload(cookie: string, category: string, file: Buffer, metadata: object) {
    const created = await request(server())
      .post('/api/v1/uploads')
      .set({ ...browser(cookie), 'Idempotency-Key': randomUUID() })
      .send({
        category,
        fileName: `test-trace-${category}.pdf`,
        fileSize: file.length,
        mimeType: 'application/pdf',
        metadata,
      });
    expect(created.status).toBe(201);
    const { uploadId, chunkSize, partCount } = created.body;
    const parts: request.Response[] = [];
    for (let part = 1; part <= partCount; part += 1) {
      const slice = file.subarray((part - 1) * chunkSize, part * chunkSize);
      const sent = await request(server())
        .put(`/api/v1/uploads/${uploadId}/parts/${part}`)
        .set({
          ...browser(cookie),
          'Content-Type': 'application/octet-stream',
          'X-Part-SHA256': sha256(slice),
        })
        .send(slice);
      expect(sent.status).toBe(200);
      parts.push(sent);
    }
    const done = await request(server())
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set(browser(cookie))
      .send({ sha256: sha256(file), partCount });
    expect(done.status).toBe(200);
    return { uploadId, parts, done };
  }

  async function setChunkSize(category: string, chunkSize: number): Promise<void> {
    const p = (await request(server()).get(`/api/v1/policies/${category}`).set(browser(admin)))
      .body;
    const saved = await request(server())
      .put(`/api/v1/policies/${category}`)
      .set(browser(admin))
      .send({
        baseVersion: p.version,
        primaryStorage: p.primaryStorage,
        fallbackStorage: p.fallbackStorage,
        encryptionAtRest: p.encryptionAtRest,
        chunkSize,
        maxParallel: p.maxParallel,
        maxFileSize: p.maxFileSize,
        allowedTypes: p.allowedTypes,
        retentionDays: p.retentionDays,
      });
    expect(saved.status).toBe(200);
  }

  const trace = (cookie: string, traceId: string) =>
    request(server()).get(`/api/v1/traces/${traceId}`).set(browser(cookie));

  const names = (spans: SpanView[]) => spans.map((s) => s.name);

  beforeAll(async () => {
    app = await createTestApp({ storage: memoryStorages().registry });
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows API, policy, encryption, storage and audit for a connection document, with durations', async () => {
    const file = Buffer.alloc(3000, 7);
    const { done } = await upload(admin, 'connection_documents', file, CONNECTION_METADATA);

    const answer = await trace(admin, done.body.traceId);

    expect(answer.status).toBe(200);
    expect(answer.body.operation).toBe('upload.complete');
    const spans: SpanView[] = answer.body.spans;
    const order = ['api', 'policy', 'encryption', 'storage.put', 'audit'].map((name) =>
      names(spans).indexOf(name),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(spans.every((s) => s.durationMs >= 0 && s.startOffsetMs >= 0)).toBe(true);
    expect(spans[0]).toMatchObject({ name: 'api', startOffsetMs: 0 });
    expect(spans[0].attributes).toMatchObject({ method: 'POST' });
    expect(spans.find((s) => s.name === 'encryption')?.attributes).toMatchObject({
      algorithm: 'AES-256-GCM',
      keyId: expect.any(String),
      sizeBytes: 3000,
    });
    expect(spans.find((s) => s.name === 'audit')?.attributes).toMatchObject({ action: 'upload' });
  });

  it('keeps personal data out of the trace', async () => {
    const file = Buffer.alloc(100, 1);
    const { done } = await upload(admin, 'connection_documents', file, CONNECTION_METADATA);

    const body = JSON.stringify((await trace(admin, done.body.traceId)).body);

    expect(body).not.toContain('Ion Popescu');
    expect(body).not.toContain('1960101123456');
    expect(body).not.toContain('RC-2026-0042');
  });

  it('has no encryption step for a category stored in clear', async () => {
    const { done } = await upload(admin, 'fault_records', Buffer.alloc(500, 2), FAULT_METADATA);

    const spans: SpanView[] = (await trace(admin, done.body.traceId)).body.spans;

    expect(names(spans)).toEqual(expect.arrayContaining(['api', 'policy', 'storage.put', 'audit']));
    expect(names(spans)).not.toContain('encryption');
  });

  it('traces every uploaded part on its own, with the part number and its traceId', async () => {
    await setChunkSize('connection_documents', MiB);
    const file = Buffer.alloc(2 * MiB + 10, 3);
    const { uploadId, parts } = await upload(
      admin,
      'connection_documents',
      file,
      CONNECTION_METADATA,
    );
    expect(parts.length).toBeGreaterThan(1);

    for (const [index, part] of parts.entries()) {
      expect(part.body.traceId).toBe(part.headers['x-trace-id']);
      const answer = await trace(admin, part.body.traceId);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        operation: 'upload.part',
        category: 'connection_documents',
        status: 'ok',
      });
      const spans: SpanView[] = answer.body.spans;
      expect(names(spans)).toEqual(expect.arrayContaining(['api', 'encryption', 'storage.put']));
      expect(spans[0].attributes).toMatchObject({ uploadId, partNumber: index + 1 });
    }
  });

  it('traces a refused part as an error', async () => {
    const created = await request(server())
      .post('/api/v1/uploads')
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'test-trace-bad.pdf',
        fileSize: 10,
        mimeType: 'application/pdf',
        metadata: FAULT_METADATA,
      });
    const refused = await request(server())
      .put(`/api/v1/uploads/${created.body.uploadId}/parts/1`)
      .set({
        ...browser(admin),
        'Content-Type': 'application/octet-stream',
        'X-Part-SHA256': 'a'.repeat(64),
      })
      .send(Buffer.alloc(10, 1));
    expect(refused.status).toBe(422);

    const answer = await trace(admin, refused.headers['x-trace-id'] as string);

    expect(answer.body).toMatchObject({ operation: 'upload.part', status: 'error' });
  });

  it('shows the audit step of a download', async () => {
    const { done } = await upload(admin, 'fault_records', Buffer.alloc(200, 4), FAULT_METADATA);
    const downloaded = await binary(
      request(server()).get(`/api/v1/files/${done.body.fileId}/content`).set(browser(admin)),
    );
    expect(downloaded.status).toBe(200);

    // The download is recorded once its bytes are sent: wait for it.
    const traceId = downloaded.headers['x-trace-id'] as string;
    let answer = await trace(admin, traceId);
    for (let attempt = 0; answer.status === 404 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      answer = await trace(admin, traceId);
    }

    expect(names(answer.body.spans)).toEqual(
      expect.arrayContaining(['api', 'storage.get', 'audit']),
    );
  });

  it('hides the trace from a role that may not see its category, like the file itself', async () => {
    const file = Buffer.alloc(100, 5);
    const { done, parts } = await upload(admin, 'fault_records', file, FAULT_METADATA);
    const password = await createUser('raluca', 'racordari');
    const racordari = await loginCookie(app, 'raluca', password);

    const hidden = await trace(racordari, done.body.traceId);
    const hiddenPart = await trace(racordari, parts[0].body.traceId);
    const missing = await trace(racordari, 'no-such-trace');

    expect(hidden.status).toBe(404);
    expect(hiddenPart.status).toBe(404);
    expect(hidden.body.code).toBe(missing.body.code);
    expect(hidden.body.message).toBe(missing.body.message);
    expect((await trace(admin, done.body.traceId)).status).toBe(200);
  });
});
