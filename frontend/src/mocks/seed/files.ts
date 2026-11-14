import type { IntegrityState, Origin, Role } from '@/lib/api/types';
import type { DocumentType, Severity, Zone } from '@/lib/upload/contract';
import type { StorageId, UploadCategoryId } from '@/lib/upload/types';
import { maskCnp, maskName } from '../handlers/uploads-validate';

/**
 * Seed of the `files` group (Task 6c.1), in the real backend's ids (docs/api.md: `fault_records`, `s3`, ...).
 * 43 files over the four categories, three zones and every origin: a normal day (12–13 Nov), the storm of
 * 14 Nov 15:33 (13:33Z), one corrupt fault, one fault written to the FTP fallback, connection documents whose
 * personal data exists only masked in `metadata` (the clear values sit in SEED_PII, the mock's sealed store).
 */

export type FileCategoryId = UploadCategoryId | 'meter_readings';

/** A row of the mock `files` collection; the uploads mock inserts the same shape (uploadedBy as a UserRef). */
export type MockFileRow = {
  id: string;
  displayName: string;
  category: FileCategoryId;
  size: number;
  mimeType: string;
  createdAt: string;
  /** Username (seed) or UserRef (uploads mock); null for meter batches. */
  uploadedBy: string | { username: string } | null;
  zone: Zone | null;
  origin: Origin;
  storage: StorageId;
  usedFallback: boolean;
  integrity: IntegrityState;
  encryptedAtRest: boolean;
  policyVersion: number;
  clientSha256: string | null;
  serverSha256: string;
  metadata: Record<string, unknown>;
  availableAt: string | null;
  uploadTraceId: string;
  lastVerifiedAt?: string | null;
  /** Mock only: the stored bytes are `mockContent(id, size)`. Rows from the uploads mock keep no bytes. */
  mockContent?: boolean;
  /** Mock only: one stored byte is flipped (demo corruption); the next download or verification detects it. */
  tampered?: boolean;
};

export type CustodyType = 'upload_completed' | 'downloaded' | 'verified' | 'pii_revealed' | 'corruption_detected' | 'demo_corrupted';

/** A row of the mock `custody` collection: events the audit trail of the seed would have produced. */
export type MockCustodyRow = {
  id: string;
  fileId: string;
  at: string;
  type: CustodyType;
  /** Username, or a system actor such as `system:download`. */
  actor: string | null;
  actingAs: Role | null;
  demo: boolean;
  reason: string | null;
  traceId: string | null;
};

export type MockSpan = {
  spanId: string;
  parentSpanId: null;
  name: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  storage: StorageId | null;
  errorCode: string | null;
};

/** GET /traces/{traceId} as backend/src/observability returns it. */
export type MockTrace = {
  traceId: string;
  operation: string;
  category: FileCategoryId | null;
  fileId: string | null;
  storage: StorageId | null;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  spans: MockSpan[];
};

// ─── deterministic content ──────────────────────────────────────────────────────────────────────────────────

/** FNV-1a of a key; never 0, so it can seed xorshift32. */
function keyHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

/** Deterministic random numbers in [0, 1) for a key (trace durations and the like). */
export function mockRandom(key: string): () => number {
  let x = keyHash(key);
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

const CONTENT_CHUNK = 256 * 1024; // a multiple of 4: the stream does not depend on chunk boundaries

/**
 * The stored bytes of a seeded file: a xorshift32 stream keyed by the id, `size` bytes, yielded in 256 KiB chunks
 * so a 1,3 GB drone video streams at constant memory. `flipAt` XORs that byte with 0xff, as the backend's demo
 * corruption does (`POST /demo/corruptions` flips the byte at `floor(size / 2)`).
 */
export function* mockContent(id: string, size: number, flipAt = -1): Generator<Uint8Array<ArrayBuffer>> {
  let x = keyHash(id);
  for (let offset = 0; offset < size; offset += CONTENT_CHUNK) {
    const n = Math.min(CONTENT_CHUNK, size - offset);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      // Typed arrays drop out-of-range writes, so the last partial word needs no bounds checks.
      out[i] = x;
      out[i + 1] = x >>> 8;
      out[i + 2] = x >>> 16;
      out[i + 3] = x >>> 24;
    }
    if (flipAt >= offset && flipAt < offset + n) out[flipAt - offset]! ^= 0xff;
    yield out;
  }
}

// ─── ids and helpers ────────────────────────────────────────────────────────────────────────────────────────

const fileId = (n: number) => `5eed0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const traceId = (n: number) => `5eed7ace${n.toString(16).padStart(24, '0')}`;
const MiB = 1024 * 1024;
/** UTC instant → the same instant as Bucharest wall time in November (+02:00), as the upload form sends it. */
const bucharest = (ms: number) => `${new Date(ms + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;

/**
 * SHA-256 of `mockContent(fileId(n), size)` per seed number, computed once with the generator above (the files
 * test re-checks every file up to 64 MiB; the four drone videos were hashed the same way).
 */
const SHA256: Record<number, string> = {
  1: 'e655f019ea99a99d727dd528336601536d86062aec7584c754a7a40b0a6ed42b', 2: '50b66ec6a9ac940e41dfe1367226ea4a17e550a658d0d89d7a1304a612dde87c',
  3: 'e9f5408af76f7a43fa364c87c56d0202763cd3e6c6aedbbc3418408ee3ef1a0f', 4: '97b3fabd2dd7a149f9dd3d114bc3663716ca495ca0eb5d010b8550686de65045',
  5: '1c33e5b3ae02c634b80df21191e9d5795ae0c5173b62b99d84d446ea16d19b09', 6: '3e4426a35e2e79ebaf432bd314db868553c9f8c3b3a0b3a76069930dbc14d8f4',
  7: 'd9675fa1f898e85c881350dd9cfdeb04d81d6c9484e6cd8126710dbcd541abad', 8: '0946906c9b1266204e4bc1ab7ad0189cd93338d1cd3aa4a900242855167fc8b6',
  9: '66b8e556537306a98c3e44037f67700cc62c7a65fd9f830948c1d45414ab1315', 10: '34d4299bd37e263fa6aaeb164f97441e1466f3786d2984a1d172391e44087164',
  11: 'ab36e23dfc911697aedeae2410b61623ad197af16f696e2c0562a04b912d0ba2', 12: '2194385e9f857cd60671ad1fd6de353c8adcfcfc3240bf5779606188ac158aef',
  13: '6a2307bdc19993aeb7db6113566d8d4dbff76549f02eb1e220e44648b53f0d24', 14: '7f93240cc0ff13c5ce64b30855382bee84f969dc75a7774b1e7812533ebfc5b9',
  15: '4ae3d38ada15fff11a06da967ecf8b05687b0215ced8ce1da84d553dd622e470', 16: '210561e8b4d24e8360be564be6cf42aa2e140116cbc67c84008dfc49223ade8c',
  17: '6c680975f3854e611300d89560ee3711eee91949f0e7615925d6a8f17e77e1a8', 18: '4a73ce0329c391bdff39516db72ed5a26b52e3dcdc547731914e81fa704274ba',
  19: '7b1c1985f2a931edbde60edb882582af5e46b8da48c51b7e2cde1550a463dea1', 20: '622bec935e163710b6b0cb65d95a061dc5fd32d58ab5ffd9a28ef72b1786176f',
  21: '455509f9e8779768561ca429e036d45f3e58425c64ff2400487e42f94a0379b1', 22: '6cd9b46388630d41580c8079fd7df7203b66ca592de9c69ff40f6b28ec9abe46',
  23: '34e3853ad273ce8ae8e850fad032f641e53459b12cea16689023bcbee2bfbf82', 24: 'faaab5939f4014e69472ac8c8620aef3bea0447ec3f38473b3227bcda778786f',
  25: '1063fb87920e84e9451e2d2d48a26028df06eb38d31b5075c1a05a5cd4b27b4d', 26: '964d3771634be5f6d79e4f6f70e21348a75b391e40e4c75de6810404e36f46ff',
  27: '42868203ab06cab277d942600872c15114c0ccef8839266ede59edd1520999de', 28: '0f4adacdf8215cd55e6ba79e68669b019841013f716469d06eb32bca002b4794',
  29: '5910cb5bfc1c8a7f9914be1bb931911984cde3cd741fadf60bc170d3711ed67a', 30: 'cc2696f2dc85a502ce2ff8771a1eec614a52082799e96084c736f703c2444316',
  31: 'ec1e19914cf3d16cf078fbda8b73f2063616f55837b78ebd0ce94d63e287d1bf', 32: '36331af1611d4ba599f5dcc12c0049a1f58d3a363ee597e3daa60f9ba69c1c23',
  33: 'e2cffe2c179bb30691c75ec152a9ceca7caafbf81364719cf4029545f5f6bd72', 34: '2791beab98164f0ca7636ef061a473474341dc330c1148b142498ba49f5dddf6',
  35: 'e1bfc08ec0a0472c763336b62468c43b4f846f8a5fef3e605bd1e8373798ce2e', 36: 'bba6980318d34aa468806a2684f12440ef0db501b8416969fefc2251d7790a3b',
  37: '1037cc89502336a21f04e05bed3aaafd6f0533b6c4040394ce4274390ad9c84f', 38: 'bcff55b9e25c702b506c16b33b6d135a26ca09350505dd78a98fd3080db34c68',
  39: '15e218c35055ac77712e320bed3c8372296878320047e154a894e76f905eb5e6', 40: '97c61e640fb58eb4cfb6511d59bd954187bcfaab181d6de948cb0ee7fcf7482b',
  41: '405852533d09498f52c1595b10604cb4f68ec9855a46c5c8c9608eb1b3d2c7ff', 42: 'c2e4565247f7a0720ae78f44d263f8d96d7e430271a716138bdeefb591cb8267',
  43: 'b1f397197524e6083035280164a0813f129ded363f88f2743d16ee38265571d3',
};

type Common = { n: number; createdAt: string; zone: Zone | null; origin: Origin; integrity?: IntegrityState; uploadedBy: string | null };

function row(c: Common & { category: FileCategoryId; displayName: string; size: number; mimeType: string; storage?: StorageId; usedFallback?: boolean; encryptedAtRest?: boolean; policyVersion: number; metadata: Record<string, unknown>; lastVerifiedAt?: string | null }): MockFileRow {
  const sha = SHA256[c.n] ?? '';
  const integrity = c.integrity ?? 'verified';
  // A client hash exists only where a person uploaded through the UI (verified, or verified then corrupted).
  const clientSha256 = c.origin === 'manual' && integrity !== 'unverified' ? sha : null;
  return {
    id: fileId(c.n), displayName: c.displayName, category: c.category, size: c.size, mimeType: c.mimeType, createdAt: c.createdAt,
    uploadedBy: c.uploadedBy, zone: c.zone, origin: c.origin, storage: c.storage ?? 's3', usedFallback: c.usedFallback ?? false, integrity,
    encryptedAtRest: c.encryptedAtRest ?? false, policyVersion: c.policyVersion, clientSha256, serverSha256: sha, metadata: c.metadata,
    availableAt: c.createdAt, uploadTraceId: traceId(c.n), lastVerifiedAt: c.lastVerifiedAt ?? null, mockContent: true,
    ...(integrity === 'corrupt' ? { tampered: true } : {}),
  };
}

const PDF = 'application/pdf';
const JPEG = 'image/jpeg';
const PNG = 'image/png';

function fault(n: number, displayName: string, size: number, mimeType: string, createdAt: string, uploadedBy: string, zone: Zone, substation: string, severity: Severity, extra: Partial<Common> & { storage?: StorageId; usedFallback?: boolean; lastVerifiedAt?: string } = {}): MockFileRow {
  const eventTime = bucharest(Date.parse(createdAt) - 18 * 60_000);
  return row({ n, category: 'fault_records', displayName, size, mimeType, createdAt, uploadedBy, zone, origin: 'manual', policyVersion: 3, metadata: { kind: 'fault', zone, substation, eventTime, severity }, ...extra });
}

function drone(n: number, displayName: string, size: number, mimeType: string, createdAt: string, zone: Zone, lineSection: string, integrity: IntegrityState = 'verified'): MockFileRow {
  return row({ n, category: 'drone_videos', displayName, size, mimeType, createdAt, uploadedBy: 'teren', zone, origin: 'manual', integrity, policyVersion: 3, metadata: { kind: 'drone', lineSection, zone, inspectionDate: createdAt.slice(0, 10) }, lastVerifiedAt: integrity === 'server_verified' ? '2026-11-13T14:02:00.000Z' : null });
}

/** The sealed personal data of the seeded connection documents (fictitious people, fictitious CNPs). */
const APPLICANTS = {
  margarit: { applicantName: 'Ioana Mărgărit', cnp: '2860415400123' },
  dumitrescu: { applicantName: 'Mihai Dumitrescu', cnp: '1790822350047' },
  turcanu: { applicantName: 'Elisabeta Țurcanu', cnp: '2920107130085' },
  balanescu: { applicantName: 'Ștefan Bălănescu', cnp: '1880530400219' },
  constantinescu: { applicantName: 'Radu Constantinescu', cnp: '1750914080031' },
} as const;
type Applicant = (typeof APPLICANTS)[keyof typeof APPLICANTS];

const piiByFile: Record<string, Applicant> = {};

function connection(n: number, requestNumber: string, documentType: DocumentType, size: number, mimeType: string, createdAt: string, zone: Zone | null, applicant: Applicant, origin: Origin = 'manual'): MockFileRow {
  piiByFile[fileId(n)] = applicant;
  const metadata = { kind: 'connection', requestNumber, documentType, ...(zone ? { zone } : {}), applicantNameMasked: maskName(applicant.applicantName), cnpMasked: maskCnp(applicant.cnp) };
  return row({
    n, category: 'connection_documents', displayName: `Document racordare ${requestNumber} (${documentType})`, size, mimeType, createdAt,
    uploadedBy: origin === 'manual' ? 'racordari' : null, zone, origin, integrity: origin === 'manual' ? 'verified' : 'server_verified',
    storage: 'db', encryptedAtRest: true, policyVersion: 2, metadata, lastVerifiedAt: origin === 'manual' ? null : '2026-11-14T07:00:00.000Z',
  });
}

const READING_BYTES = 124;

function meter(n: number, createdAt: string, zone: Zone, readings: number, origin: Origin): MockFileRow {
  return row({
    n, category: 'meter_readings', displayName: `Citiri contoare ${createdAt.slice(0, 19)}Z (${readings})`, size: readings * READING_BYTES,
    mimeType: 'application/x-ndjson', createdAt, uploadedBy: null, zone, origin, integrity: 'server_verified', storage: 'db', policyVersion: 1,
    metadata: { kind: 'meter_batch', readings },
  });
}

// ─── files ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SEED_IDS = {
  fallbackFault: fileId(5),
  corruptFault: fileId(6),
  unverifiedFault: fileId(7),
  stormFault: fileId(8),
  droneLarge: fileId(18),
  connectionRequest: fileId(19),
  connectionActing: fileId(23),
} as const;

export const SEED_FILES: MockFileRow[] = [
  // Fault records: normal days, then the storm burst in Dobrogea.
  fault(1, 'Avarie_PT_Medgidia_12.pdf', 2_457_600, PDF, '2026-11-12T07:42:10.000Z', 'teren', 'dobrogea', 'PT Medgidia 12', 'high'),
  fault(2, 'Avarie_Stația_Timișoara_Nord.jpg', 3_145_728, JPEG, '2026-11-12T10:05:44.000Z', 'teren', 'banat', 'Stația Timișoara Nord', 'medium'),
  fault(3, 'Raport_avarie_LEA_20kV_Ploiești.pdf', 1_258_291, PDF, '2026-11-12T13:18:02.000Z', 'dispecerat', 'muntenia', 'LEA 20 kV Ploiești Vest', 'low', { origin: 'seed', integrity: 'server_verified', uploadedBy: null, lastVerifiedAt: '2026-11-13T07:00:00.000Z' }),
  fault(4, 'Avarie_PT_Constanța_Sud.png', 4_718_592, PNG, '2026-11-13T06:55:31.000Z', 'teren', 'dobrogea', 'PT Constanța Sud', 'critical', { integrity: 'server_verified', lastVerifiedAt: '2026-11-13T12:00:00.000Z' }),
  fault(5, 'Defect_celulă_MT_Arad.pdf', 1_887_437, PDF, '2026-11-13T09:12:07.000Z', 'teren', 'banat', 'Celula MT Arad 3', 'high', { storage: 'ftp', usedFallback: true }),
  fault(6, 'Avarie_Buzău_PT_7.pdf', 2_202_009, PDF, '2026-11-13T15:40:19.000Z', 'dispecerat', 'muntenia', 'PT Buzău 7', 'medium', { integrity: 'corrupt', lastVerifiedAt: '2026-11-14T10:15:42.000Z' }),
  fault(7, 'Inventar_avarii_noiembrie.pdf', 6_291_456, PDF, '2026-11-13T17:02:00.000Z', 'dispecerat', 'muntenia', 'Centru dispecerat Ploiești', 'low', { origin: 'seed', integrity: 'unverified', uploadedBy: null }),
  fault(8, 'Furtună_Tulcea_PT_3.jpg', 2_831_155, JPEG, '2026-11-14T13:33:12.000Z', 'teren', 'dobrogea', 'PT Tulcea 3', 'critical'),
  fault(9, 'Furtună_Constanța_LEA_110kV.pdf', 5_452_595, PDF, '2026-11-14T13:36:40.000Z', 'teren', 'dobrogea', 'LEA 110 kV Constanța Nord', 'critical'),
  fault(10, 'Furtună_Mangalia_PT_14.png', 3_670_016, PNG, '2026-11-14T13:41:05.000Z', 'teren', 'dobrogea', 'PT Mangalia 14', 'high'),
  fault(11, 'Furtună_Medgidia_celulă_2.pdf', 1_572_864, PDF, '2026-11-14T13:47:58.000Z', 'dispecerat', 'dobrogea', 'Stația Medgidia, celula 2', 'high'),
  fault(12, 'Furtună_Ploiești_LEA_20kV.jpg', 2_621_440, JPEG, '2026-11-14T13:55:21.000Z', 'teren', 'muntenia', 'LEA 20 kV Ploiești Est', 'medium'),
  fault(13, 'Furtună_Lugoj_PT_9.pdf', 4_194_304, PDF, '2026-11-14T14:08:47.000Z', 'teren', 'banat', 'PT Lugoj 9', 'high'),
  fault(14, 'Avarie_Reșița_PT_21.pdf', 1_048_576, PDF, '2026-11-14T15:20:33.000Z', 'teren', 'banat', 'PT Reșița 21', 'low'),

  // Drone inspection videos: few, very large (one over 1 GB).
  drone(15, 'Inspecție_LEA_110kV_Medgidia–Constanța.mp4', 700 * MiB, 'video/mp4', '2026-11-12T11:20:00.000Z', 'dobrogea', 'LEA 110 kV Medgidia–Constanța'),
  drone(16, 'Inspecție_LEA_20kV_Lugoj_Est.mp4', 180 * MiB, 'video/mp4', '2026-11-13T08:05:00.000Z', 'banat', 'LEA 20 kV Lugoj Est'),
  drone(17, 'Zbor_dronă_Ploiești_Nord.mov', 400 * MiB, 'video/quicktime', '2026-11-13T12:47:00.000Z', 'muntenia', 'LEA 110 kV Ploiești Nord', 'server_verified'),
  drone(18, 'Inspecție_post_furtună_Tulcea.mp4', 1_395_864_371, 'video/mp4', '2026-11-14T16:10:00.000Z', 'dobrogea', 'LEA 110 kV Tulcea–Isaccea'),

  // Connection documents: DB, encrypted at rest, personal data masked.
  connection(19, 'RC-2026-0412', 'cerere', 845_312, PDF, '2026-11-12T08:30:00.000Z', 'muntenia', APPLICANTS.margarit),
  connection(20, 'RC-2026-0412', 'act_identitate', 1_153_434, JPEG, '2026-11-12T08:31:10.000Z', 'muntenia', APPLICANTS.margarit),
  connection(21, 'RC-2026-0419', 'cerere', 612_352, PDF, '2026-11-12T14:02:00.000Z', 'banat', APPLICANTS.dumitrescu),
  connection(22, 'RC-2026-0419', 'aviz', 2_097_152, PDF, '2026-11-13T10:44:00.000Z', 'banat', APPLICANTS.dumitrescu),
  connection(23, 'RC-2026-0433', 'cerere', 731_136, PDF, '2026-11-13T13:15:00.000Z', 'dobrogea', APPLICANTS.turcanu),
  connection(24, 'RC-2026-0433', 'act_identitate', 1_572_864, PNG, '2026-11-13T13:16:30.000Z', 'dobrogea', APPLICANTS.turcanu),
  connection(25, 'RC-2026-0440', 'cerere', 524_288, PDF, '2026-11-14T07:50:00.000Z', 'muntenia', APPLICANTS.balanescu),
  connection(26, 'RC-2026-0441', 'aviz', 3_355_443, PDF, '2026-11-14T09:25:00.000Z', null, APPLICANTS.constantinescu, 'seed'),

  // Meter readings: regular simulator batches, the storm peak, and the initial seed.
  meter(27, '2026-11-12T08:00:00.000Z', 'muntenia', 120, 'simulator'),
  meter(28, '2026-11-12T08:00:05.000Z', 'banat', 96, 'simulator'),
  meter(29, '2026-11-12T08:00:10.000Z', 'dobrogea', 88, 'simulator'),
  meter(30, '2026-11-12T20:00:00.000Z', 'muntenia', 132, 'simulator'),
  meter(31, '2026-11-13T08:00:00.000Z', 'banat', 101, 'simulator'),
  meter(32, '2026-11-13T08:00:05.000Z', 'dobrogea', 92, 'simulator'),
  meter(33, '2026-11-13T20:00:00.000Z', 'muntenia', 127, 'simulator'),
  meter(34, '2026-11-14T08:00:00.000Z', 'banat', 99, 'simulator'),
  meter(35, '2026-11-14T08:00:05.000Z', 'dobrogea', 90, 'simulator'),
  meter(36, '2026-11-14T08:00:10.000Z', 'muntenia', 125, 'simulator'),
  meter(37, '2026-11-14T13:33:30.000Z', 'dobrogea', 380, 'storm'),
  meter(38, '2026-11-14T13:34:00.000Z', 'dobrogea', 395, 'storm'),
  meter(39, '2026-11-14T13:34:30.000Z', 'muntenia', 310, 'storm'),
  meter(40, '2026-11-14T13:35:00.000Z', 'banat', 288, 'storm'),
  meter(41, '2026-11-14T13:35:30.000Z', 'dobrogea', 402, 'storm'),
  meter(42, '2026-11-11T08:00:00.000Z', 'muntenia', 12, 'seed'),
  meter(43, '2026-11-11T08:00:05.000Z', 'banat', 10, 'seed'),
];

/** Clear personal data per connection document: returned only by an audited reveal, never listed or searched. */
export const SEED_PII: Readonly<Record<string, { applicantName: string; cnp: string }>> = piiByFile;

// ─── custody and traces of past operations ──────────────────────────────────────────────────────────────────

const byId = (id: string) => SEED_FILES.find((f) => f.id === id)!;

function opTrace(n: number, operation: string, file: MockFileRow, at: string, spans: [name: string, start: number, duration: number, errorCode?: string][]): MockTrace {
  const durationMs = Math.max(...spans.map(([, s, d]) => s + d)) + 1.2;
  const failed = spans.some(([, , , e]) => e);
  return {
    traceId: traceId(n), operation, category: file.category, fileId: file.id, storage: file.storage, startedAt: at, durationMs, status: failed ? 'error' : 'ok',
    spans: spans.map(([name, startOffsetMs, d, errorCode], i) => ({
      spanId: String(i + 1), parentSpanId: null, name, startOffsetMs, durationMs: d, status: errorCode ? 'error' : 'ok',
      storage: name.startsWith('storage.') || name === 'hash.verify' ? file.storage : null, errorCode: errorCode ?? null,
    })),
  };
}

const corrupt = byId(SEED_IDS.corruptFault);
const request = byId(SEED_IDS.connectionRequest);
const acting = byId(SEED_IDS.connectionActing);
const verifiedFault = byId(fileId(4));
const verifiedDrone = byId(fileId(17));

/** Traces of the seeded downloads and verifications (upload traces are derived from the file rows). */
export const SEED_TRACES: MockTrace[] = [
  opTrace(101, 'file.download', corrupt, '2026-11-13T16:02:11.000Z', [['storage.get', 1.4, 38.6]]),
  opTrace(102, 'file.download', corrupt, '2026-11-14T10:15:42.000Z', [['storage.get', 1.1, 41.3, 'IntegrityError']]),
  opTrace(103, 'file.download', request, '2026-11-12T09:02:00.000Z', [['storage.get', 0.9, 12.7]]),
  opTrace(104, 'file.verify', verifiedFault, '2026-11-13T12:00:00.000Z', [['hash.verify', 0.8, 61.5]]),
  opTrace(105, 'file.verify', verifiedDrone, '2026-11-13T14:02:00.000Z', [['hash.verify', 1.0, 4_870.2]]),
];

let custodySeq = 0;
function event(file: MockFileRow, type: CustodyType, at: string, actor: string | null, extra: Partial<MockCustodyRow> = {}): MockCustodyRow {
  custodySeq += 1;
  return { id: `c-seed-${custodySeq}`, fileId: file.id, at, type, actor, actingAs: null, demo: false, reason: null, traceId: null, ...extra };
}

/** What the audit trail of the seed would show: every manual upload, plus the downloads, checks and reveals above. */
export const SEED_CUSTODY: MockCustodyRow[] = [
  ...SEED_FILES.filter((f) => f.origin === 'manual').map((f) =>
    event(f, 'upload_completed', f.createdAt, typeof f.uploadedBy === 'string' ? f.uploadedBy : null, { traceId: f.uploadTraceId })),
  event(corrupt, 'downloaded', '2026-11-13T16:02:11.000Z', 'dispecerat', { traceId: traceId(101) }),
  event(corrupt, 'corruption_detected', '2026-11-14T10:15:42.000Z', 'system:download', { traceId: traceId(102) }),
  event(request, 'downloaded', '2026-11-12T09:02:00.000Z', 'racordari', { traceId: traceId(103) }),
  event(request, 'pii_revealed', '2026-11-13T09:10:00.000Z', 'auditor', { reason: 'Control intern GDPR: verificarea identității solicitantului' }),
  event(acting, 'pii_revealed', '2026-11-14T08:40:00.000Z', 'admin', { actingAs: 'auditor', demo: true, reason: 'Repetiție demo: verificare dosar de racordare' }),
  event(verifiedFault, 'verified', '2026-11-13T12:00:00.000Z', 'auditor', { traceId: traceId(104) }),
  event(verifiedDrone, 'verified', '2026-11-13T14:02:00.000Z', 'auditor', { traceId: traceId(105) }),
];
