import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
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
    expect(response.body).toEqual({ status: 'ready', database: 'ok' });
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
      error: {
        code: 'not_found',
        message: expect.any(String),
        trace_id: 'trace-404',
        details: null,
      },
    });
  });

  it('turns unhandled errors into a 500 envelope without leaking the message', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-only/boom')
      .set('X-Trace-Id', 'trace-500');

    expect(response.status).toBe(500);
    expect(response.headers['x-trace-id']).toBe('trace-500');
    expect(response.body.error).toMatchObject({ code: 'internal_error', trace_id: 'trace-500' });
    expect(response.text).not.toContain('hunter2');
  });

  it('lists invalid fields without echoing the submitted values', async () => {
    const response = await request(app.getHttpServer())
      .post('/test-only/validate')
      .send({ username: 'ana', password: 's3cret-value', attempts: 'many' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details.map((detail: { path: string[] }) => detail.path)).toEqual([
      ['attempts'],
    ]);
    expect(response.text).not.toContain('s3cret-value');
  });

  it('answers malformed JSON with a 400 envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/test-only/validate')
      .set('Content-Type', 'application/json')
      .send('{"username": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_request');
    expect(response.body.error.trace_id).toMatch(HEX32);
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
  it('reports 503 when the database is unreachable', async () => {
    const app = await createTestApp({
      env: { DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/nowhere' },
    });
    try {
      const response = await request(app.getHttpServer()).get('/readyz');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable', database: 'error' });
    } finally {
      await app.close();
    }
  });
});
