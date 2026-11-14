import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { StreamEvent } from '../src/events/events.types';
import { EventBus } from '../src/events/event-bus.service';
import { GuaranteeEvaluator } from '../src/guarantees/guarantee-evaluator';
import {
  browser,
  createTestApp,
  loginCookie,
  memoryStorages,
  resetDatabase,
  testDb,
} from './helpers';

const HEX = 'a'.repeat(64);

/** The simulator's GET /control, with a loss figure the test controls (or no answer at all). */
function fakeSimulator() {
  const state = { sent: 100, acked: 100, queue: 0, down: false };
  const server: Server = createServer((_request, response) => {
    if (state.down) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        mode: 'normal',
        ratePerS: 10,
        normalRatePerS: 10,
        peakRatePerS: 100,
        queueDepth: state.queue,
        sentUnique: state.sent,
        ackedUnique: state.acked,
      }),
    );
  });
  return { state, server };
}

async function faultUploads(durationsMs: number[]): Promise<void> {
  const db = testDb();
  try {
    await db
      .insertInto('operations')
      .values(
        durationsMs.map((duration_ms) => ({
          trace_id: randomUUID().replaceAll('-', ''),
          operation: 'upload.complete',
          category: 'fault_records' as const,
          storage: 's3' as const,
          status: 'ok' as const,
          started_at: new Date(),
          duration_ms,
          spans: '[]',
        })),
      )
      .execute();
  } finally {
    await db.destroy();
  }
}

async function connectionFile(encrypted: boolean): Promise<void> {
  const db = testDb();
  try {
    await db
      .insertInto('files')
      .values({
        category: 'connection_documents',
        display_name: 'Document racordare RC-1 (cerere)',
        mime_type: 'application/pdf',
        size_bytes: 10,
        sha256: HEX,
        storage: 's3',
        storage_key: `connection_documents/${randomUUID()}.bin`,
        stored_size_bytes: 10,
        stored_sha256: HEX,
        encrypted,
        integrity: 'verified',
        policy_version: 1,
        metadata: '{}',
        upload_trace_id: 'trace-x',
      })
      .execute();
  } finally {
    await db.destroy();
  }
}

async function droneTransfer(status: 'completed' | 'failed', resumeCount = 0): Promise<void> {
  const db = testDb();
  try {
    await db
      .insertInto('upload_sessions')
      .values({
        idempotency_key: randomUUID(),
        category: 'drone_videos',
        file_name: 'zbor.mp4',
        display_name: 'zbor.mp4',
        mime_type: 'video/mp4',
        file_size: 100,
        chunk_size: 1024 * 1024,
        part_count: 1,
        max_parallel: 1,
        policy_version: 1,
        encrypted: false,
        primary_storage: 'ftp',
        metadata: '{}',
        status,
        created_by: 'admin',
        started_as_role: 'admin',
        trace_id: 'trace-y',
        expires_at: new Date(Date.now() + 3_600_000),
        resume_count: resumeCount,
      })
      .execute();
  } finally {
    await db.destroy();
  }
}

interface Guarantee {
  category: string;
  state: string;
  causeCode: string | null;
  metrics: { key: string; value: string | null }[];
}

describe('business guarantees and alerts', () => {
  let app: NestExpressApplication;
  let admin: string;
  const simulator = fakeSimulator();
  const events: StreamEvent[] = [];

  const guarantees = async (): Promise<Record<string, Guarantee>> => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/guarantees')
      .set(browser(admin));
    expect(response.status).toBe(200);
    return Object.fromEntries((response.body.data as Guarantee[]).map((g) => [g.category, g]));
  };
  const metric = (g: Guarantee, key: string) => g.metrics.find((m) => m.key === key)?.value;
  const alerts = (state = 'active') =>
    request(app.getHttpServer()).get('/api/v1/alerts').query({ state }).set(browser(admin));

  beforeAll(async () => {
    await new Promise<void>((resolve) => simulator.server.listen(0, '127.0.0.1', resolve));
    const { port } = simulator.server.address() as AddressInfo;
    app = await createTestApp({
      storage: memoryStorages().registry,
      env: { SIMULATOR_URL: `http://127.0.0.1:${port}`, GUARANTEE_EVAL_INTERVAL_S: '3600' },
    });
    app.get(EventBus).subscribe((event) => events.push(event));
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await loginCookie(app);
    Object.assign(simulator.state, { sent: 100, acked: 100, queue: 0, down: false });
    events.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => simulator.server.close(resolve));
  });

  it('reports the four guarantees as ok on a healthy system, with their metrics', async () => {
    const all = await guarantees();

    expect(Object.keys(all).sort()).toEqual([
      'connection_documents',
      'drone_videos',
      'fault_records',
      'meter_readings',
    ]);
    for (const g of Object.values(all)) expect(g).toMatchObject({ state: 'ok', causeCode: null });
    expect(all.meter_readings.metrics.map((m) => m.key)).toEqual([
      'received',
      'unique',
      'duplicatesRejected',
      'lost',
    ]);
    expect(metric(all.meter_readings, 'lost')).toBe('0');
    expect(metric(all.fault_records, 'uploadToAvailableP95Ms')).toBeNull();
    expect(metric(all.connection_documents, 'encryptedPct')).toBe('100');
    expect(all.drone_videos.metrics.map((m) => m.key)).toEqual([
      'transfersCompleted',
      'transfersResumed',
      'transfersFailed',
      'successRate',
    ]);
  });

  it('flags lost meter readings as violated and an unknown loss as at risk', async () => {
    simulator.state.acked = 97;
    const lost = (await guarantees()).meter_readings;
    simulator.state.down = true;
    const unknown = (await guarantees()).meter_readings;

    expect(lost).toMatchObject({ state: 'violated', causeCode: 'METER_READINGS_LOST' });
    expect(metric(lost, 'lost')).toBe('3');
    expect(unknown).toMatchObject({ state: 'at_risk', causeCode: 'METER_LOSS_UNKNOWN' });
    expect(metric(unknown, 'lost')).toBeNull();
  });

  it('compares the fault upload-to-available p95 with GUARANTEE_FAULT_P95_MS', async () => {
    await faultUploads(Array.from({ length: 20 }, () => 4500));
    const near = (await guarantees()).fault_records;
    await faultUploads(Array.from({ length: 40 }, () => 9000));
    const above = (await guarantees()).fault_records;

    expect(near).toMatchObject({ state: 'at_risk', causeCode: 'FAULT_P95_NEAR_TARGET' });
    expect(above).toMatchObject({ state: 'violated', causeCode: 'FAULT_P95_ABOVE_TARGET' });
    expect(Number(metric(above, 'uploadToAvailableP95Ms'))).toBeGreaterThan(5000);
  });

  it('requires every connection document to be encrypted at rest', async () => {
    await connectionFile(true);
    await connectionFile(false);

    const g = (await guarantees()).connection_documents;

    expect(g).toMatchObject({ state: 'violated', causeCode: 'CONNECTION_NOT_ENCRYPTED' });
    expect(metric(g, 'encryptedPct')).toBe('50');
  });

  it('counts drone transfers completed, resumed and failed', async () => {
    await droneTransfer('completed', 2);
    await droneTransfer('completed');
    await droneTransfer('failed');

    const g = (await guarantees()).drone_videos;

    expect(g).toMatchObject({ state: 'violated', causeCode: 'DRONE_SUCCESS_BELOW_TARGET' });
    expect(metric(g, 'transfersCompleted')).toBe('2');
    expect(metric(g, 'transfersResumed')).toBe('1');
    expect(metric(g, 'transfersFailed')).toBe('1');
    expect(Number(metric(g, 'successRate'))).toBeCloseTo(2 / 3, 3);
  });

  it('raises an alert on a transition, publishes it, and resolves it when the guarantee is back', async () => {
    const evaluator = app.get(GuaranteeEvaluator);
    await connectionFile(false);

    await evaluator.evaluateOnce();
    await evaluator.evaluateOnce(); // no new transition: still one alert
    const active = await alerts('active');

    expect(active.body.data).toHaveLength(1);
    expect(active.body.data[0]).toMatchObject({
      category: 'connection_documents',
      state: 'violated',
      causeCode: 'CONNECTION_NOT_ENCRYPTED',
      causeFacts: { encryptedPct: 0, unencrypted: 1 },
      resolvedAt: null,
      acknowledgedAt: null,
    });
    expect(events.filter((e) => e.type === 'alert.raised')).toHaveLength(1);
    expect(events.some((e) => e.type === 'guarantees.status')).toBe(true);

    const db = testDb();
    await db.updateTable('files').set({ encrypted: true }).execute();
    await db.destroy();
    await evaluator.evaluateOnce();

    expect((await alerts('active')).body.data).toHaveLength(0);
    const resolved = await alerts('resolved');
    expect(resolved.body.data[0]).toMatchObject({
      state: 'resolved',
      resolvedAt: expect.any(String),
    });
    expect(events.filter((e) => e.type === 'alert.updated')).toHaveLength(1);
  });

  it('acknowledges an alert once (idempotent, audited) and answers 404 for an unknown one', async () => {
    await connectionFile(false);
    await app.get(GuaranteeEvaluator).evaluateOnce();
    const [alert] = (await alerts()).body.data;
    const ack = () =>
      request(app.getHttpServer())
        .post(`/api/v1/alerts/${alert.id}/acknowledge`)
        .set(browser(admin));

    const first = await ack();
    const second = await ack();
    const unknown = await request(app.getHttpServer())
      .post(`/api/v1/alerts/${randomUUID()}/acknowledge`)
      .set(browser(admin));

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      id: alert.id,
      acknowledgedAt: expect.any(String),
      acknowledgedBy: { username: 'admin' },
    });
    expect(second.body.acknowledgedAt).toBe(first.body.acknowledgedAt);
    expect(unknown.status).toBe(404);
    const audit = await request(app.getHttpServer())
      .get('/api/v1/audit-events')
      .query({ action: 'alert_ack' })
      .set(browser(admin));
    expect(audit.body.meta.total).toBe(1);
  });
});
