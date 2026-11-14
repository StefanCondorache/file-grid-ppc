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
  sessionCookieFrom,
  testDb,
} from './helpers';

const MiB = 1024 * 1024;
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function bytes(size: number, seed = 7): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

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

describe('uploads, downloads and files', () => {
  let app: NestExpressApplication;
  let admin: string;
  let storages: ReturnType<typeof memoryStorages>;
  const server = () => app.getHttpServer();

  async function setChunkSize(category: string, chunkSize: number): Promise<void> {
    const p = (await request(server()).get(`/api/v1/policies/${category}`).set(browser(admin)))
      .body;
    const response = await request(server())
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
    expect(response.status).toBe(200);
  }

  function create(cookie: string, body: Record<string, unknown>, key: string = randomUUID()) {
    return request(server())
      .post('/api/v1/uploads')
      .set({ ...browser(cookie), 'Idempotency-Key': key })
      .send(body);
  }

  function putPart(
    cookie: string,
    uploadId: string,
    part: number,
    data: Buffer,
    sha = sha256(data),
  ) {
    return request(server())
      .put(`/api/v1/uploads/${uploadId}/parts/${part}`)
      .set({ ...browser(cookie), 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sha })
      .send(data);
  }

  function complete(cookie: string, uploadId: string, file: Buffer, partCount: number) {
    return request(server())
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set(browser(cookie))
      .send({ sha256: sha256(file), partCount });
  }

  /** Create, send every part, complete: returns the completion response. */
  async function upload(cookie: string, category: string, file: Buffer, metadata: object) {
    const created = await create(cookie, {
      category,
      fileName: `test-${category}.pdf`,
      fileSize: file.length,
      mimeType: 'application/pdf',
      metadata,
    });
    expect(created.status).toBe(201);
    const { uploadId, chunkSize, partCount } = created.body;
    for (let part = 1; part <= partCount; part += 1) {
      const slice = file.subarray((part - 1) * chunkSize, part * chunkSize);
      expect((await putPart(cookie, uploadId, part, slice)).status).toBe(200);
    }
    return complete(cookie, uploadId, file, partCount);
  }

  const download = (cookie: string, fileId: string) =>
    binary(request(server()).get(`/api/v1/files/${fileId}/content`).set(browser(cookie)));

  beforeAll(async () => {
    storages = memoryStorages();
    app = await createTestApp({ storage: storages.registry });
  });

  beforeEach(async () => {
    await resetDatabase();
    await storages.reset();
    admin = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('uploads a fault record in parts, confirms both hashes and downloads it intact', async () => {
    await setChunkSize('fault_records', MiB);
    const file = bytes(Math.round(2.5 * MiB));
    const created = await create(admin, {
      category: 'fault_records',
      fileName: 'raport-avarie.pdf',
      fileSize: file.length,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'open',
      chunkSize: MiB,
      partCount: 3,
      policyVersion: 2,
      receivedRanges: [],
    });
    const { uploadId } = created.body;

    for (const part of [1, 2, 3]) {
      const sent = await putPart(
        admin,
        uploadId,
        part,
        file.subarray((part - 1) * MiB, part * MiB),
      );
      expect(sent.body).toMatchObject({ partNumber: part, alreadyReceived: false });
    }
    const status = await request(server()).get(`/api/v1/uploads/${uploadId}`).set(browser(admin));
    expect(status.body).toMatchObject({ receivedRanges: [[1, 3]], receivedBytes: file.length });

    const done = await complete(admin, uploadId, file, 3);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'completed',
      verdict: 'match',
      clientSha256: sha256(file),
      serverSha256: sha256(file),
      size: file.length,
      storage: 's3',
      usedFallback: false,
      encryptedAtRest: false,
    });

    const content = await download(admin, done.body.fileId);
    expect(content.status).toBe(200);
    expect(sha256(content.body as Buffer)).toBe(sha256(file));
    expect(content.headers['x-file-sha256']).toBe(sha256(file));
    expect(content.headers['content-disposition']).toContain('attachment;');

    const listed = await request(server())
      .get('/api/v1/files?category=fault_records')
      .set(browser(admin));
    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.data[0]).toMatchObject({
      id: done.body.fileId,
      integrity: 'verified',
      zone: 'banat',
    });

    const trace = await request(server())
      .get(`/api/v1/traces/${done.body.traceId}`)
      .set(browser(admin));
    expect(trace.status).toBe(200);
    expect(trace.body.spans.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(['policy', 'storage.put', 'confirm']),
    );
    expect(
      storages
        .adapter('s3')
        .keys()
        .some((key) => key.startsWith('staging/')),
    ).toBe(false);
  });

  it('resumes: reports the missing parts, then completes after they arrive', async () => {
    await setChunkSize('fault_records', MiB);
    const file = bytes(2 * MiB, 3);
    const created = await create(admin, {
      category: 'fault_records',
      fileName: 'reluare.pdf',
      fileSize: file.length,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    });
    const { uploadId } = created.body;
    await putPart(admin, uploadId, 2, file.subarray(MiB));

    const early = await complete(admin, uploadId, file, 2);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: 'PARTS_MISSING', missingRanges: [[1, 1]] });

    const again = await putPart(admin, uploadId, 2, file.subarray(MiB));
    expect(again.body.alreadyReceived).toBe(true);
    await putPart(admin, uploadId, 1, file.subarray(0, MiB));
    expect((await complete(admin, uploadId, file, 2)).body.verdict).toBe('match');
  });

  it('returns the same session for a repeated Idempotency-Key', async () => {
    const body = {
      category: 'fault_records',
      fileName: 'a.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    };
    const key = randomUUID();

    const first = await create(admin, body, key);
    const second = await create(admin, body, key);
    const conflicting = await create(admin, { ...body, fileSize: 11 }, key);

    expect([first.status, second.status, conflicting.status]).toEqual([201, 200, 409]);
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(conflicting.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a part whose checksum does not match and keeps nothing of it', async () => {
    const created = await create(admin, {
      category: 'fault_records',
      fileName: 'x.pdf',
      fileSize: 100,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    });

    const response = await putPart(admin, created.body.uploadId, 1, bytes(100), 'f'.repeat(64));

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PART_CHECKSUM_MISMATCH');
    expect(storages.adapter('s3').keys()).toEqual([]);
  });

  it('refuses the file when the whole-file hash differs from the client hash', async () => {
    const file = bytes(1000);
    const created = await create(admin, {
      category: 'fault_records',
      fileName: 'y.pdf',
      fileSize: 1000,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    });
    await putPart(admin, created.body.uploadId, 1, file);

    const response = await complete(admin, created.body.uploadId, bytes(1000, 9), 1);

    expect(response.body).toMatchObject({ status: 'failed', verdict: 'mismatch', fileId: null });
    const files = await request(server()).get('/api/v1/files').set(browser(admin));
    expect(files.body.meta.total).toBe(0);
  });

  it('falls back to the policy fallback storage when the primary is down', async () => {
    storages.adapter('s3').setAvailable(false);

    const done = await upload(admin, 'fault_records', bytes(5000), FAULT_METADATA);

    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ verdict: 'match', storage: 'db', usedFallback: true });
  });

  it('encrypts connection documents at rest, masks personal data and reveals it only to the auditor', async () => {
    const file = Buffer.from('%PDF-1.7 cerere Ion Popescu CNP 1960101123456 '.repeat(50));

    const done = await upload(admin, 'connection_documents', file, CONNECTION_METADATA);
    expect(done.body).toMatchObject({ verdict: 'match', encryptedAtRest: true, storage: 's3' });

    const s3 = storages.adapter('s3');
    const raw = s3.read(s3.keys()[0]);
    expect(raw.subarray(0, 4).toString()).toBe('FGE1');
    expect(raw.includes(Buffer.from('Popescu'))).toBe(false);

    const detail = await request(server())
      .get(`/api/v1/files/${done.body.fileId}`)
      .set(browser(admin));
    expect(detail.body.metadata).toMatchObject({
      applicantNameMasked: 'I*** P***',
      cnpMasked: '1*********456',
    });
    expect(detail.text).not.toContain('Popescu');
    expect(detail.body.displayName).toBe('Document racordare RC-2026-0042 (cerere)');

    const reason = { reason: 'Verificare dosar la cererea clientului' };
    const adminReveal = await request(server())
      .post(`/api/v1/files/${done.body.fileId}/reveal`)
      .set(browser(admin))
      .send(reason);
    expect(adminReveal.status).toBe(403);

    const auditor = sessionCookieFrom(
      await request(server())
        .post('/api/v1/demo/acting-role')
        .set(browser(admin))
        .send({ role: 'auditor' }),
    );
    const revealed = await request(server())
      .post(`/api/v1/files/${done.body.fileId}/reveal`)
      .set(browser(auditor))
      .send(reason);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ applicantName: 'Ion Popescu', cnp: '1960101123456' });

    const content = await download(admin, done.body.fileId);
    expect((content.body as Buffer).equals(file)).toBe(true);
  });

  it('detects a corrupted file on download and marks it corrupt', async () => {
    const done = await upload(admin, 'fault_records', bytes(4096), FAULT_METADATA);

    const corrupted = await request(server())
      .post('/api/v1/demo/corruptions')
      .set(browser(admin))
      .send({ fileId: done.body.fileId });
    const content = await request(server())
      .get(`/api/v1/files/${done.body.fileId}/content`)
      .set(browser(admin));
    const verification = await request(server())
      .post(`/api/v1/files/${done.body.fileId}/verification`)
      .set(browser(admin));

    expect(corrupted.status).toBe(201);
    expect(content.status).toBe(409);
    expect(content.body).toMatchObject({
      code: 'FILE_CORRUPT',
      expectedSha256: done.body.serverSha256,
    });
    expect(verification.body.state).toBe('corrupt');
    const db = testDb();
    try {
      const row = await db
        .selectFrom('files')
        .select('integrity')
        .where('id', '=', done.body.fileId)
        .executeTakeFirstOrThrow();
      expect(row.integrity).toBe('corrupt');
    } finally {
      await db.destroy();
    }
  });

  it('enforces roles: upload rights per category, and invisible files answer 404', async () => {
    const done = await upload(admin, 'fault_records', bytes(100), FAULT_METADATA);
    const password = await createUser('raluca', 'racordari');
    const racordari = await loginCookie(app, 'raluca', password);

    const forbiddenUpload = await create(racordari, {
      category: 'fault_records',
      fileName: 'z.pdf',
      fileSize: 5,
      mimeType: 'application/pdf',
      metadata: FAULT_METADATA,
    });
    const hidden = await request(server())
      .get(`/api/v1/files/${done.body.fileId}`)
      .set(browser(racordari));
    const list = await request(server()).get('/api/v1/files').set(browser(racordari));

    expect(forbiddenUpload.status).toBe(403);
    expect(hidden.status).toBe(404);
    expect(list.body.meta.total).toBe(0);
  });

  it('rejects a type the policy does not allow and a file above the size limit', async () => {
    const base = { category: 'connection_documents', metadata: CONNECTION_METADATA };
    const wrongType = await create(admin, {
      ...base,
      fileName: 'v.mp4',
      fileSize: 10,
      mimeType: 'video/mp4',
    });
    const tooBig = await create(admin, {
      ...base,
      fileName: 'big.pdf',
      fileSize: 51 * MiB,
      mimeType: 'application/pdf',
    });

    expect(wrongType.status).toBe(422);
    expect(wrongType.body.code).toBe('TYPE_NOT_ALLOWED');
    expect(tooBig.status).toBe(413);
  });
});
