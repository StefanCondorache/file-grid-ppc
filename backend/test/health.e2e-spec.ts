import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CSRF_HEADER, fakeSecret } from './constants';
import { createTestApp, resetDatabase } from './helpers';
import { memoryLogDestination } from './log-capture';
import { TestOnlyModule } from './test-only.module';

const HEX32 = /^[0-9a-f]{32}$/;

describe('health probes, trace id and error envelope', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({ extraModules: [TestOnlyModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers /healthz', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('checks the database in /readyz', async () => {
    const response = await request(app.getHttpServer()).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', database: 'ok' });
  });

  it('generates a trace id when the client sends none', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');

    expect(response.headers['x-trace-id']).toMatch(HEX32);
  });

  it('echoes a valid incoming trace id', async () => {
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('X-Trace-Id', 'abc-123');

    expect(response.headers['x-trace-id']).toBe('abc-123');
  });

  it('replaces an invalid incoming trace id', async () => {
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .set('X-Trace-Id', 'bad id!!');

    expect(response.headers['x-trace-id']).toMatch(HEX32);
  });

  it('wraps unknown routes in the error envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .set('X-Trace-Id', 'trace-404');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Resursa nu există.',
      traceId: 'trace-404',
    });
  });

  it('turns unhandled errors into a 500 envelope without leaking the message', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-only/boom')
      .set('X-Trace-Id', 'trace-500');

    expect(response.status).toBe(500);
    expect(response.headers['x-trace-id']).toBe('trace-500');
    expect(response.body).toMatchObject({ code: 'INTERNAL_ERROR', traceId: 'trace-500' });
    expect(response.text).not.toContain('hunter2');
  });

  it('lists invalid fields without echoing the submitted values', async () => {
    const submitted = fakeSecret();
    const response = await request(app.getHttpServer())
      .post('/api/v1/test-only/validate')
      .set(CSRF_HEADER)
      .send({ username: 'ana', password: submitted, attempts: 'many' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.fieldErrors.map((error: { field: string }) => error.field)).toEqual([
      'attempts',
    ]);
    expect(response.text).not.toContain(submitted);
  });

  it('answers malformed JSON with a 400 envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test-only/validate')
      .set(CSRF_HEADER)
      .set('Content-Type', 'application/json')
      .send('{"username": ');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('MALFORMED_JSON');
    expect(response.body.traceId).toMatch(HEX32);
  });
});

describe('request logging', () => {
  it('logs each request as one JSON line with its trace id', async () => {
    const destination = memoryLogDestination();
    const app = await createTestApp({ logDestination: destination });
    try {
      await request(app.getHttpServer())
        .get('/api/does-not-exist')
        .set('X-Trace-Id', 'trace-log-1');
    } finally {
      await app.close();
    }

    const line = destination
      .lines()
      .find((entry) => entry.message === 'request' && entry.trace_id === 'trace-log-1');
    expect(line).toMatchObject({ method: 'GET', path: '/api/does-not-exist', status: 404 });
  });
});

describe('readiness without a database', () => {
  it('stays ready (so the pod keeps serving) and reports the database as down', async () => {
    const app = await createTestApp({
      env: { FILEGRID_PG_DSN: 'postgresql://nobody:x@127.0.0.1:1/nowhere' },
    });
    try {
      const response = await request(app.getHttpServer()).get('/readyz');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'degraded', database: 'error' });
    } finally {
      await app.close();
    }
  });
});
