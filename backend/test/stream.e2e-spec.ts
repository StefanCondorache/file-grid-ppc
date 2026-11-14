import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { ClusterChannel } from '../src/events/cluster-channel.service';
import { EventBus } from '../src/events/event-bus.service';
import { TEST_JWT_SECRET } from './constants';
import {
  browser,
  createTestApp,
  createUser,
  loginCookie,
  memoryStorages,
  resetDatabase,
} from './helpers';
import { type OpenStream, type SseFrame, listen, openStream, sleep } from './sse';

const nowS = (): number => Math.floor(Date.now() / 1000);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function sessionToken(claims: Record<string, unknown>): string {
  return jwt.sign(
    {
      sub: 'admin',
      uid: '00000000-0000-0000-0000-000000000001',
      name: 'Administrator',
      role: 'admin',
      idle: nowS() + 600,
      iss: 'filegrid',
      aud: 'filegrid-api',
      iat: nowS(),
      exp: nowS() + 3600,
      ...claims,
    },
    TEST_JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

async function untilListening(app: NestExpressApplication): Promise<void> {
  const channel = app.get(ClusterChannel);
  for (let i = 0; i < 100 && !channel.listening; i += 1) await sleep(50);
  if (!channel.listening) throw new Error('cluster channel did not connect');
}

const ofType = (type: string) => (frame: SseFrame) => frame.event === type;

describe('GET /stream (Server-Sent Events)', () => {
  let a: NestExpressApplication;
  let b: NestExpressApplication;
  let urlA: string;
  let urlB: string;
  let admin: string;
  const streams: OpenStream[] = [];
  const open = async (url: string, headers: Record<string, string>) => {
    const stream = await openStream(url, headers);
    streams.push(stream);
    return stream;
  };

  beforeAll(async () => {
    await resetDatabase();
    const env = { STREAM_PING_S: '0.4', STREAM_COUNTERS_INTERVAL_S: '0.5' };
    a = await createTestApp({ env, storage: memoryStorages().registry });
    b = await createTestApp({ env, storage: memoryStorages().registry });
    urlA = await listen(a);
    urlB = await listen(b);
    await Promise.all([untilListening(a), untilListening(b)]);
    admin = await loginCookie(a);
  });

  afterEach(() => {
    for (const stream of streams.splice(0)) stream.close();
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('opens an event stream with the SSE headers, retry: 3000 and a first ping', async () => {
    const stream = await open(urlA, { Cookie: admin });

    const ping = await stream.waitFor(ofType('ping'));

    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(stream.text().startsWith('retry: 3000\n')).toBe(true);
    expect(ping.data).toEqual({ serverTime: expect.any(String) });
  });

  it('answers 401 without a session', async () => {
    const stream = await open(urlA, {});

    expect(stream.status).toBe(401);
  });

  it('does not extend the session (no Set-Cookie on the stream)', async () => {
    const stale = sessionToken({ idle: nowS() + 300 });
    const stream = await open(urlA, { Cookie: `__Host-fg_session=${stale}` });

    expect(stream.status).toBe(200);
    expect(stream.headers['set-cookie']).toBeUndefined();
  });

  it('sends a named ping every STREAM_PING_S with monotonic ids', async () => {
    const stream = await open(urlA, { Cookie: admin });

    await sleep(1000);
    const pings = stream.frames.filter(ofType('ping'));
    const ids = stream.frames.map((frame) => Number(frame.id)).filter(Number.isFinite);

    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes exactly one replica the leader for the periodic jobs', async () => {
    const leaders = await Promise.all([a, b].map((app) => app.get(ClusterChannel).isLeader()));

    expect(leaders.filter(Boolean)).toHaveLength(1);
  });

  it('carries an event published on one replica to the clients of another', async () => {
    const onB = await open(urlB, { Cookie: admin });
    const onA = await open(urlA, { Cookie: admin });
    await onB.waitFor(ofType('ping'));
    const policy = (
      await request(a.getHttpServer()).get('/api/v1/policies/fault_records').set(browser(admin))
    ).body;

    const updated = await request(a.getHttpServer())
      .put('/api/v1/policies/fault_records')
      .set(browser(admin))
      .send({ ...policy, baseVersion: policy.version, maxConcurrency: 9 });

    expect(updated.status).toBe(200);
    const expected = { category: 'fault_records', version: policy.version + 1 };
    expect((await onB.waitFor(ofType('policy.updated'))).data).toEqual(expected);
    expect((await onA.waitFor(ofType('policy.updated'))).data).toEqual(expected);
  });

  it('filters events by the capabilities of the active role', async () => {
    const username = `rac-${randomUUID().slice(0, 8)}`;
    const racordari = await loginCookie(a, username, await createUser(username, 'racordari'));
    const limited = await open(urlA, { Cookie: racordari });
    const full = await open(urlA, { Cookie: admin });
    await Promise.all([limited.waitFor(ofType('ping')), full.waitFor(ofType('ping'))]);
    const bus = a.get(EventBus);

    bus.publish(
      'file.created',
      { fileId: 'f1', category: 'fault_records' },
      { capability: 'view_fault' },
    );
    bus.publish('upload.verified', { uploadId: 'u1', verdict: 'match' }, { username: 'admin' });
    bus.publish('demo.storm', { category: 'meter_readings', factor: 10, state: 'started' });

    await full.waitFor(ofType('demo.storm'));
    await limited.waitFor(ofType('demo.storm'));
    expect(full.frames.some(ofType('file.created'))).toBe(true);
    expect(full.frames.some(ofType('upload.verified'))).toBe(true);
    expect(limited.frames.some(ofType('file.created'))).toBe(false);
    expect(limited.frames.some(ofType('upload.verified'))).toBe(false);
  });

  it('coalesces snapshot events to at most two per second, newest last', async () => {
    const stream = await open(urlA, { Cookie: admin });
    await stream.waitFor(ofType('ping'));
    const bus = a.get(EventBus);

    for (let i = 1; i <= 20; i += 1) {
      bus.publish('simulator.status', { mode: 'custom', ratePerS: i }, undefined, {
        localOnly: true,
      });
    }
    await sleep(1100);

    const snapshots = stream.frames.filter(ofType('simulator.status'));
    expect(snapshots.length).toBe(2);
    expect(snapshots.map((frame) => (frame.data as { ratePerS: number }).ratePerS)).toEqual([
      1, 20,
    ]);
  });

  it('publishes meter counters periodically to roles that see meters', async () => {
    const stream = await open(urlB, { Cookie: admin });

    const counters = await stream.waitFor(ofType('meters.counters'), 4000);

    expect(counters.data).toMatchObject({
      received: expect.any(Number),
      unique: expect.any(Number),
    });
  });

  it('tells the uploader that the upload was verified and the viewers that a file was created', async () => {
    const stream = await open(urlB, { Cookie: admin });
    await stream.waitFor(ofType('ping'));
    const file = Buffer.from('raport avarie '.repeat(100));
    const created = await request(a.getHttpServer())
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
          substation: 'Stația Arad',
          eventTime: '2026-11-14T10:00:00Z',
          severity: 'high',
        },
      });
    await request(a.getHttpServer())
      .put(`/api/v1/uploads/${created.body.uploadId}/parts/1`)
      .set({ ...browser(admin), 'Content-Type': 'application/octet-stream' })
      .send(file);
    const done = await request(a.getHttpServer())
      .post(`/api/v1/uploads/${created.body.uploadId}/complete`)
      .set(browser(admin))
      .send({ sha256: sha256(file), partCount: 1 });

    expect(done.body.verdict).toBe('match');
    expect((await stream.waitFor(ofType('upload.verified'))).data).toMatchObject({
      uploadId: created.body.uploadId,
      fileId: done.body.fileId,
      verdict: 'match',
      serverSha256: sha256(file),
    });
    expect((await stream.waitFor(ofType('file.created'))).data).toMatchObject({
      fileId: done.body.fileId,
      category: 'fault_records',
      zone: 'banat',
      severity: 'high',
      substation: 'Stația Arad',
      origin: 'manual',
    });
  });

  it('ends the stream when the session expires', async () => {
    const shortLived = sessionToken({ idle: nowS() + 1 });
    const stream = await open(urlA, { Cookie: `__Host-fg_session=${shortLived}` });
    const started = Date.now();

    await stream.ended;

    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('GET /stream on shutdown', () => {
  it('closes open streams so the app can stop', async () => {
    const app = await createTestApp({ storage: memoryStorages().registry });
    const url = await listen(app);
    const stream = await openStream(url, { Cookie: await loginCookie(app) });
    await stream.waitFor(ofType('ping'));

    await app.close();
    await stream.ended;

    expect(stream.status).toBe(200);
  });
});
