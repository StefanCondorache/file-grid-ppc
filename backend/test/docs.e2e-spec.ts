import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ClusterChannel } from '../src/events/cluster-channel.service';
import { TEST_METER_KEY } from './constants';
import {
  binary,
  browser,
  createTestApp,
  createUser,
  login,
  loginCookie,
  memoryStorages,
  resetDatabase,
} from './helpers';
import { type OpenApiDoc, type Schema, check, documentedResponse } from './openapi-check';
import { listen, openStream, sleep } from './sse';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const PREFIX = '/api/v1';
/** Not part of the document: it describes the API under /api/v1, not itself. */
const UNDOCUMENTED = new Set([`GET ${PREFIX}/docs-json`]);

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route Nest registered under /api/v1, as "METHOD /path/{param}". */
function nestRoutes(app: NestExpressApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: RouteLayer[] } };
  return express.router.stack.flatMap((layer) => {
    const route = layer.route;
    if (!route || !route.path.startsWith(`${PREFIX}/`)) return [];
    const key = (method: string) => `${method.toUpperCase()} ${route.path}`;
    return Object.keys(route.methods)
      .filter((method) => !UNDOCUMENTED.has(key(method)))
      .map((method) => `${method.toUpperCase()} ${toOpenApi(route.path.slice(PREFIX.length))}`);
  });
}

const toOpenApi = (path: string): string => path.replace(/:(\w+)/g, '{$1}');

function documentedRoutes(doc: OpenApiDoc): string[] {
  return Object.entries(doc.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => ['get', 'head', 'post', 'put', 'delete', 'patch'].includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/** The `x-sse-events` map of GET /stream: event name -> payload schema $ref. */
function sseEvents(doc: OpenApiDoc): Record<string, string> {
  const stream = doc.paths['/stream']?.get as unknown as
    { 'x-sse-events'?: Record<string, string> } | undefined;
  const events = stream?.['x-sse-events'];
  if (!events) throw new Error('GET /stream has no x-sse-events');
  return events;
}

describe('GET /api/v1/docs-json: the OpenAPI document of the real API', () => {
  let app: NestExpressApplication;
  let doc: OpenApiDoc;
  const storages = memoryStorages();
  const server = () => app.getHttpServer();

  /** Every mismatch between real answers and the document, reported together at the end. */
  let problems: string[] = [];

  function conforms(method: string, path: string, response: request.Response): void {
    const label = `${method} ${path} ${response.status}`;
    const documented = documentedResponse(doc, method, path, response.status);
    if (!documented) {
      problems.push(`${label}: not documented`);
      return;
    }
    if (documented.schema) {
      problems.push(...check(doc, documented.schema, response.body).map((p) => `${label} ${p}`));
    }
  }

  beforeEach(() => {
    problems = [];
  });

  afterEach(() => {
    expect(problems).toEqual([]);
  });

  beforeAll(async () => {
    app = await createTestApp({
      storage: storages.registry,
      env: {
        STREAM_PING_S: '0.3',
        STREAM_COUNTERS_INTERVAL_S: '0.5',
        GUARANTEE_EVAL_INTERVAL_S: '0.5',
      },
    });
    await resetDatabase();
    const answer = await request(server()).get(`${PREFIX}/docs-json`);
    expect(answer.status).toBe(200);
    doc = answer.body;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is an OpenAPI 3 document for the /api/v1 server, without a session', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers).toEqual([{ url: PREFIX }]);
  });

  it('has no dangling $ref', () => {
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.add(value);
          else walk(value);
        }
      }
    };
    walk(doc);
    const sseRefs = Object.values(sseEvents(doc));
    const resolves = (ref: string): boolean => {
      const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? [];
      const components = doc.components as unknown as Record<string, Record<string, unknown>>;
      return Boolean(section && name && components[section]?.[name]);
    };

    expect([...refs, ...sseRefs].filter((ref) => !resolves(ref))).toEqual([]);
  });

  it('lists every Nest route, and only routes Nest has', () => {
    const real = new Set(nestRoutes(app));
    const documented = new Set(documentedRoutes(doc));
    expect(real.size).toBeGreaterThan(30);

    expect([...real].filter((route) => !documented.has(route)).sort()).toEqual([]);
    expect([...documented].filter((route) => !real.has(route)).sort()).toEqual([]);
  });

  it('describes the real answers of a whole session: login, policies, upload, files, audit', async () => {
    const auditorPassword = await createUser('ana', 'auditor');
    const loggedIn = await login(app);
    conforms('POST', '/auth/login', loggedIn);
    const admin = await loginCookie(app);
    const get = (path: string, cookie = admin) =>
      request(server())
        .get(PREFIX + path)
        .set(browser(cookie));

    conforms('GET', '/ping', await get('/ping'));
    conforms('GET', '/auth/login-options', await get('/auth/login-options'));
    conforms('GET', '/auth/me', await get('/auth/me'));
    conforms('GET', '/policies', await get('/policies'));
    const policy = await get('/policies/connection_documents');
    conforms('GET', '/policies/{category}', policy);
    conforms('GET', '/policies/{category}/versions', await get('/policies/fault_records/versions'));
    const { version, category: _category, ...settings } = policy.body;
    const saved = await request(server())
      .put(`${PREFIX}/policies/connection_documents`)
      .set(browser(admin))
      .send({ ...settings, baseVersion: version, chunkSize: 1024 * 1024 });
    conforms('PUT', '/policies/{category}', saved);
    const stale = await request(server())
      .put(`${PREFIX}/policies/connection_documents`)
      .set(browser(admin))
      .send({ ...settings, baseVersion: version, chunkSize: 1024 * 1024 });
    conforms('PUT', '/policies/{category}', stale);

    const file = Buffer.alloc(3000, 9);
    const created = await request(server())
      .post(`${PREFIX}/uploads`)
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'connection_documents',
        fileName: 'test-docs-cerere.pdf',
        fileSize: file.length,
        mimeType: 'application/pdf',
        metadata: {
          kind: 'connection',
          requestNumber: 'RC-2026-0099',
          documentType: 'cerere',
          applicantName: 'Maria Ionescu',
          cnp: '2960101123456',
        },
      });
    conforms('POST', '/uploads', created);
    const { uploadId } = created.body;
    const part = await request(server())
      .put(`${PREFIX}/uploads/${uploadId}/parts/1`)
      .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
      .send(file);
    conforms('PUT', '/uploads/{uploadId}/parts/{partNumber}', part);
    conforms('GET', '/uploads/{uploadId}', await get(`/uploads/${uploadId}`));
    const done = await request(server())
      .post(`${PREFIX}/uploads/${uploadId}/complete`)
      .set(browser(admin))
      .send({ sha256: sha256(file), partCount: 1 });
    conforms('POST', '/uploads/{uploadId}/complete', done);
    const { fileId, traceId } = done.body;

    conforms('GET', '/files', await get('/files'));
    conforms('GET', '/files/{fileId}', await get(`/files/${fileId}`));
    conforms('GET', '/files/{fileId}', await get(`/files/${randomUUID()}`));
    const content = await binary(
      request(server()).get(`${PREFIX}/files/${fileId}/content`).set(browser(admin)),
    );
    expect(content.status).toBe(200);
    const verified = await request(server())
      .post(`${PREFIX}/files/${fileId}/verification`)
      .set(browser(admin));
    conforms('POST', '/files/{fileId}/verification', verified);
    conforms('GET', '/files/{fileId}/custody', await get(`/files/${fileId}/custody`));
    const auditor = await loginCookie(app, 'ana', auditorPassword);
    const revealed = await request(server())
      .post(`${PREFIX}/files/${fileId}/reveal`)
      .set(browser(auditor))
      .send({ reason: 'Verificare la cererea titularului' });
    conforms('POST', '/files/{fileId}/reveal', revealed);
    conforms('GET', '/traces/{traceId}', await get(`/traces/${traceId}`));
    conforms('GET', '/audit-events', await get('/audit-events'));
    conforms(
      'POST',
      '/auth/refresh',
      await request(server()).post(`${PREFIX}/auth/refresh`).set(browser(admin)),
    );
  });

  it('describes the monitoring, meters, statistics and demo answers', async () => {
    const admin = await loginCookie(app);
    const get = (path: string) =>
      request(server())
        .get(PREFIX + path)
        .set(browser(admin));
    const ingested = await request(server())
      .post(`${PREFIX}/meter-readings`)
      .set('X-API-Key', TEST_METER_KEY)
      .send({
        readings: [
          {
            readingId: 'RO-BAN-000001:1',
            meterId: 'RO-BAN-000001',
            zone: 'banat',
            readingTime: '2026-11-14T12:00:00Z',
            kwh: 1.5,
            sequence: 1,
            origin: 'simulator',
          },
        ],
      });
    conforms('POST', '/meter-readings', ingested);

    for (const path of [
      '/meter-readings',
      '/meters/counters',
      '/guarantees',
      '/alerts',
      '/storage-health',
      '/metrics/matrix',
      '/metrics/bulkhead',
      '/statistics/periods',
      '/statistics/storage-fit',
      '/statistics/grid-insights',
      '/demo/status',
    ]) {
      conforms('GET', path, await get(path));
    }
    conforms('GET', '/files', await get('/files?page=0'));
    conforms('HEAD', '/ping', await request(server()).head(`${PREFIX}/ping`));
    conforms('GET', '/meters/simulator', await get('/meters/simulator'));
    const post = (path: string, body?: object) =>
      request(server())
        .post(PREFIX + path)
        .set(browser(admin))
        .send(body);
    conforms(
      'POST',
      '/alerts/{alertId}/acknowledge',
      await post(`/alerts/${randomUUID()}/acknowledge`),
    );
    conforms('POST', '/demo/acting-role', await post('/demo/acting-role', { role: 'teren' }));
    conforms(
      'DELETE',
      '/demo/acting-role',
      await request(server()).delete(`${PREFIX}/demo/acting-role`).set(browser(admin)),
    );
    const started = await request(server())
      .post(`${PREFIX}/uploads`)
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'drone_videos',
        fileName: 'test-docs-zbor.mp4',
        fileSize: 10,
        mimeType: 'video/mp4',
        metadata: {
          kind: 'drone',
          lineSection: 'LEA Test',
          zone: 'dobrogea',
          inspectionDate: '2026-11-14',
        },
      });
    conforms('POST', '/uploads', started);
    conforms(
      'DELETE',
      '/uploads/{uploadId}',
      await request(server())
        .delete(`${PREFIX}/uploads/${started.body.uploadId}`)
        .set(browser(admin)),
    );
    conforms(
      'POST',
      '/demo/corruptions',
      await post('/demo/corruptions', { fileId: randomUUID() }),
    );
    conforms('POST', '/auth/logout', await post('/auth/logout'));
    conforms('GET', '/statistics/period-comparison', await get('/statistics/period-comparison'));
    const periods = (await get('/statistics/periods')).body.data as { id: string }[];
    if (periods.length >= 2) {
      const [a, b] = periods;
      conforms(
        'GET',
        '/statistics/period-comparison',
        await get(`/statistics/period-comparison?a=${a?.id}&b=${b?.id}`),
      );
    }
  });
  it('describes every live event of GET /stream (x-sse-events) and their payloads', async () => {
    const events = sseEvents(doc);
    const channel = app.get(ClusterChannel);
    for (let i = 0; i < 100 && !channel.listening; i += 1) await sleep(50);
    const admin = await loginCookie(app);
    const stream = await openStream(await listen(app), browser(admin));
    expect(stream.status).toBe(200);

    const policy = (
      await request(server()).get(`${PREFIX}/policies/fault_records`).set(browser(admin))
    ).body;
    const { version, category: _category, ...settings } = policy;
    await request(server())
      .put(`${PREFIX}/policies/fault_records`)
      .set(browser(admin))
      .send({ ...settings, baseVersion: version, retentionDays: settings.retentionDays + 1 });
    const file = Buffer.alloc(500, 3);
    const created = await request(server())
      .post(`${PREFIX}/uploads`)
      .set({ ...browser(admin), 'Idempotency-Key': randomUUID() })
      .send({
        category: 'fault_records',
        fileName: 'test-docs-avarie.pdf',
        fileSize: file.length,
        mimeType: 'application/pdf',
        metadata: {
          kind: 'fault',
          zone: 'banat',
          substation: 'Stația Test',
          eventTime: '2026-11-14T10:00:00Z',
          severity: 'low',
        },
      });
    await request(server())
      .put(`${PREFIX}/uploads/${created.body.uploadId}/parts/1`)
      .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
      .send(file);
    const done = await request(server())
      .post(`${PREFIX}/uploads/${created.body.uploadId}/complete`)
      .set(browser(admin))
      .send({ sha256: sha256(file), partCount: 1 });
    await request(server())
      .post(`${PREFIX}/files/${done.body.fileId}/verification`)
      .set(browser(admin));
    // storage.health is sent when a storage changes state: take FTP down and up again.
    storages.adapter('ftp').setAvailable(false);
    await storages.registry.monitor.checkOnce();
    await stream
      .waitFor((frame) => frame.event === 'storage.health', 5000)
      .catch(() => problems.push('event storage.health: not received'));
    storages.adapter('ftp').setAvailable(true);
    await storages.reset();
    const expected = [
      'ping',
      'meters.counters',
      'policy.updated',
      'upload.verified',
      'file.created',
      'file.integrity',
      'guarantees.status',
    ];
    for (const name of expected) {
      await stream
        .waitFor((frame) => frame.event === name, 5000)
        .catch(() => problems.push(`event ${name}: not received`));
    }
    stream.close();

    for (const frame of stream.frames) {
      if (!frame.event) continue;
      const schemaRef = events[frame.event];
      if (!schemaRef) {
        problems.push(`event ${frame.event}: not documented`);
        continue;
      }
      const schema: Schema = { $ref: schemaRef };
      problems.push(...check(doc, schema, frame.data).map((p) => `event ${frame.event} ${p}`));
    }
  });
});
