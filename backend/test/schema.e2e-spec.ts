import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { migrateToLatest, migrateToNothing } from '../src/database/migrator';
import type { Database } from '../src/database/schema';
import { createDatabase } from '../src/database/database';
import { resetDatabase, testConfig, testDb } from './helpers';

const EXPECTED_TABLES = [
  'audit_log',
  'files',
  'meter_batches',
  'meter_readings',
  'operations',
  'policies',
  'policy_versions',
  'upload_parts',
  'upload_sessions',
  'users',
];

function batchFile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category: 'meter_readings' as const,
    display_name: 'readings.jsonl',
    mime_type: 'application/x-ndjson',
    size_bytes: 10,
    sha256: 'a'.repeat(64),
    storage: 'db' as const,
    storage_key: `meter/2026/11/14/${id}.jsonl`,
    stored_size_bytes: 10,
    stored_sha256: 'a'.repeat(64),
    encrypted: false,
    integrity: 'server_verified' as const,
    policy_version: 1,
    uploaded_by: 'meter:test',
    upload_trace_id: 'trace-schema',
    ...overrides,
  };
}

function reading(fileId: string, kwh = '1.250') {
  return {
    reading_id: 'RO-BAN-000001:2026-11-14T12:00Z',
    meter_id: 'RO-BAN-000001',
    zone: 'banat' as const,
    reading_time: new Date('2026-11-14T12:00:00Z'),
    kwh,
    sequence: 1,
    origin: 'simulator' as const,
    file_id: fileId,
    trace_id: 'trace-schema',
  };
}

async function publicTables(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ tablename: string }>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`.execute(db);
  return result.rows.map((row) => row.tablename);
}

describe('metadata schema (migration 0001)', () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('creates every metadata table', async () => {
    expect(await publicTables(db)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
  });

  it('seeds one policy per category, with version 1 recorded', async () => {
    const rows = await db
      .selectFrom('policies')
      .select(['category', 'primary_storage', 'fallback_storage', 'encrypted', 'version'])
      .orderBy('category')
      .execute();
    const versions = await db.selectFrom('policy_versions').select('category').execute();

    expect(rows).toEqual([
      {
        category: 'connection_documents',
        primary_storage: 's3',
        fallback_storage: 'db',
        encrypted: true,
        version: 1,
      },
      {
        category: 'drone_videos',
        primary_storage: 'ftp',
        fallback_storage: 's3',
        encrypted: false,
        version: 1,
      },
      {
        category: 'fault_records',
        primary_storage: 's3',
        fallback_storage: 'db',
        encrypted: false,
        version: 1,
      },
      {
        category: 'meter_readings',
        primary_storage: 'db',
        fallback_storage: 's3',
        encrypted: false,
        version: 1,
      },
    ]);
    expect(versions).toHaveLength(4);
  });

  it.each([
    [
      "UPDATE policies SET fallback_storage = 's3' WHERE category = 'fault_records'",
      'ck_policies_fallback_differs',
    ],
    [
      "UPDATE policies SET primary_storage = 'nfs' WHERE category = 'fault_records'",
      'ck_policies_primary_storage',
    ],
    [
      "UPDATE policies SET chunk_size_bytes = 1024 WHERE category = 'fault_records'",
      'ck_policies_chunk_size',
    ],
    [
      "UPDATE policies SET max_concurrency = 0 WHERE category = 'fault_records'",
      'ck_policies_max_concurrency',
    ],
    [
      "INSERT INTO policies (category, primary_storage, encrypted, chunk_size_bytes, max_parallel, max_concurrency, max_file_size_bytes, retention_days) VALUES ('selfies', 's3', false, 1048576, 1, 1, 1, 1)",
      'ck_policies_category',
    ],
    [
      "UPDATE policies SET encrypted = false WHERE category = 'connection_documents'",
      'ck_policies_connection_encrypted',
    ],
  ])('enforces %#: %s', async (statement, constraint) => {
    await expect(sql.raw(statement).execute(db)).rejects.toThrow(constraint);
  });

  it('rejects a malformed sha256 on files', async () => {
    await expect(
      db
        .insertInto('files')
        .values(batchFile(randomUUID(), { sha256: 'not-a-hash' }))
        .execute(),
    ).rejects.toThrow('ck_files_sha256_hex');
  });

  it('rejects a second reading with the same reading_id', async () => {
    const fileId = randomUUID();
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('files').values(batchFile(fileId)).execute();
      await trx.insertInto('meter_readings').values(reading(fileId)).execute();
    });

    await expect(
      db.insertInto('meter_readings').values(reading(fileId, '9.000')).execute(),
    ).rejects.toThrow('pk_meter_readings');
  });

  it('accepts a reading written before its batch file in the same transaction', async () => {
    const fileId = randomUUID();
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('meter_readings').values(reading(fileId)).execute();
      await trx.insertInto('files').values(batchFile(fileId)).execute();
    });

    const { count } = await db
      .selectFrom('meter_readings')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(count)).toBe(1);
  });

  it('rejects a reading whose batch file never appears', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('meter_readings').values(reading(randomUUID())).execute();
      }),
    ).rejects.toThrow('fk_meter_readings_file_id_files');
  });

  it('survives the database killing a connection in the middle of a transaction', async () => {
    const app = createDatabase(testConfig());
    const admin = testDb();
    try {
      const failure = app.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        await sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(trx);
      });

      await expect(failure).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { rows } = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(app);
      expect(rows[0].ok).toBe(1);
    } finally {
      await app.destroy();
      await admin.destroy();
    }
  });

  it('migrates down to nothing and back up again', async () => {
    await migrateToNothing(db);
    expect(await publicTables(db)).not.toEqual(expect.arrayContaining(['policies']));

    await migrateToLatest(db);
    expect(await publicTables(db)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    const policies = await db.selectFrom('policies').select('category').execute();
    expect(policies).toHaveLength(4);
  });
});
