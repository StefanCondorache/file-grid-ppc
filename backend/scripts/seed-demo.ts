/**
 * Realistic demo data, uploaded through the public API so policies, encryption and the audit trail
 * apply exactly as for a real upload (docs/api.md, "Resumable upload"):
 *   - 60 fault records (JSON reports) in Dobrogea, Muntenia and Banat, by substation and county,
 *     deliberately uneven so the grid statistics show where most faults happen;
 *   - 20 connection documents (one-page PDFs) with invented applicants and CNPs;
 *   - 4 short drone inspection videos (a test pattern made by ffmpeg; skipped without ffmpeg).
 * Idempotent: every name starts with `seed-` (connection documents: `RC-SEED-`), and what already
 * exists is not uploaded again.
 *
 * Usage (Node 26 runs it as is):
 *   FILEGRID_URL=https://<host> npm run seed:demo
 * Login: passwordless when the backend allows it (demo mode); otherwise set SEED_ADMIN_PASSWORD and
 * SEED_DEMO_PASSWORD (the DEMO_USERS_PASSWORD of the demo accounts). Without demo accounts the
 * admin uploads everything. Nothing secret is printed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.FILEGRID_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const CSRF = { 'X-Requested-With': 'filegrid' };

type Zone = 'muntenia' | 'banat' | 'dobrogea';
type Category = 'fault_records' | 'connection_documents' | 'drone_videos';
type Uploader = 'teren' | 'dispecerat' | 'racordari' | 'admin';

interface SeedFile {
  readonly category: Category;
  readonly fileName: string;
  /** The display name the backend gives the file (connection documents get one from metadata). */
  readonly displayName: string;
  readonly mimeType: string;
  readonly uploader: Uploader;
  readonly metadata: Record<string, unknown>;
  readonly body: () => Buffer;
}

/** A small deterministic PRNG (mulberry32): the same data on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = random(20261114);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
const pad = (n: number, width: number): string => String(n).padStart(width, '0');

const SUBSTATIONS: Readonly<Record<Zone, readonly string[]>> = {
  dobrogea: [
    'Stația 110 kV Constanța Sud (CT)',
    'Stația 110 kV Medgidia (CT)',
    'Stația 110 kV Mangalia (CT)',
    'Stația 110 kV Cernavodă (CT)',
    'Stația 110 kV Tulcea Vest (TL)',
    'Stația 110 kV Isaccea (TL)',
  ],
  muntenia: [
    'Stația 110 kV București Sud (B)',
    'Stația 110 kV Ploiești Nord (PH)',
    'Stația 110 kV Pitești Sud (AG)',
    'Stația 110 kV Târgoviște (DB)',
    'Stația 110 kV Buzău (BZ)',
    'Stația 110 kV Giurgiu Nord (GR)',
  ],
  banat: [
    'Stația 110 kV Timișoara Nord (TM)',
    'Stația 110 kV Lugoj (TM)',
    'Stația 110 kV Arad (AR)',
    'Stația 110 kV Reșița (CS)',
    'Stația 110 kV Caransebeș (CS)',
  ],
};
/** Uneven on purpose: the statistics name the zone with the most faults. */
const FAULTS_PER_ZONE: Readonly<Record<Zone, number>> = { dobrogea: 27, muntenia: 21, banat: 12 };
const SEVERITIES = ['low', 'low', 'medium', 'medium', 'medium', 'high', 'critical'] as const;
const CAUSES = [
  'Defect de izolație pe linia de 20 kV',
  'Descărcare atmosferică',
  'Întrerupător declanșat la suprasarcină',
  'Cablu subteran deteriorat la lucrări',
  'Vânt puternic, conductor rupt',
  'Defect transformator de putere',
];
const FIRST_NAMES = [
  'Andrei',
  'Maria',
  'Ioana',
  'Mihai',
  'Elena',
  'Radu',
  'Ana',
  'Cristian',
  'Gabriela',
  'Vlad',
];
const LAST_NAMES = [
  'Popescu',
  'Ionescu',
  'Dumitrescu',
  'Stan',
  'Marin',
  'Georgescu',
  'Constantin',
  'Tudor',
];
const ZONES: readonly Zone[] = ['dobrogea', 'muntenia', 'banat'];
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 9, 15, 6, 0, 0); // 15.10.2026, the first day of the seeded month

function faults(): SeedFile[] {
  const out: SeedFile[] = [];
  let n = 0;
  for (const zone of ZONES) {
    for (let i = 0; i < FAULTS_PER_ZONE[zone]; i += 1) {
      n += 1;
      const substation = pick(SUBSTATIONS[zone]);
      const severity = pick(SEVERITIES);
      const eventTime = new Date(START + Math.floor(rnd() * 30 * DAY_MS)).toISOString();
      const report = {
        raport: `AV-SEED-${pad(n, 4)}`,
        zona: zone,
        statie: substation,
        dataEveniment: eventTime,
        severitate: severity,
        cauza: pick(CAUSES),
        consumatoriAfectati: Math.floor(rnd() * 4000) + 50,
        durataIntrerupereMin: Math.floor(rnd() * 240) + 5,
      };
      const fileName = `seed-avarie-${pad(n, 3)}.json`;
      out.push({
        category: 'fault_records',
        fileName,
        displayName: fileName,
        mimeType: 'application/json',
        uploader: n % 2 === 0 ? 'dispecerat' : 'teren',
        metadata: { kind: 'fault', zone, substation, eventTime, severity },
        body: () => Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
      });
    }
  }
  return out;
}

/** An invented CNP with a valid control digit (format only: no real person behind it). */
function cnp(): string {
  const sex = pick(['1', '2', '5', '6']);
  const year = pad(Math.floor(rnd() * 40) + 60, 2);
  const month = pad(Math.floor(rnd() * 12) + 1, 2);
  const day = pad(Math.floor(rnd() * 28) + 1, 2);
  const county = pad(pick([13, 36, 40, 29, 3, 35, 11, 2]), 2);
  const serial = pad(Math.floor(rnd() * 900) + 100, 3);
  const twelve = `${sex}${year}${month}${day}${county}${serial}`;
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const sum = twelve
    .split('')
    .reduce((acc, digit, i) => acc + Number(digit) * (weights[i] ?? 0), 0);
  const control = sum % 11 === 10 ? 1 : sum % 11;
  return `${twelve}${control}`;
}

/** A minimal one-page PDF with a few lines of text (ASCII: the base fonts have no ș/ț). */
function pdf(lines: readonly string[]): Buffer {
  const ascii = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[()\\]/g, '\\$&');
  const text = lines.map((line, i) => `BT /F1 12 Tf 60 ${770 - i * 22} Td (${ascii(line)}) Tj ET`);
  const content = text.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${pad(o, 10)} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function connections(): SeedFile[] {
  const types = ['cerere', 'cerere', 'cerere', 'aviz', 'act_identitate'] as const;
  return Array.from({ length: 20 }, (_, i) => {
    const requestNumber = `RC-SEED-2026-${pad(i + 1, 4)}`;
    const documentType = types[i % types.length] ?? 'cerere';
    const applicantName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const zone = ZONES[i % ZONES.length] ?? 'muntenia';
    const title =
      documentType === 'aviz'
        ? 'Aviz tehnic de racordare'
        : documentType === 'act_identitate'
          ? 'Copie act de identitate (date fictive)'
          : 'Cerere de racordare la reteaua de distributie';
    const lines = [
      title,
      `Numar cerere: ${requestNumber}`,
      `Solicitant: ${applicantName} (persoana fictiva, date de demonstratie)`,
      `Zona: ${zone}`,
      `Putere solicitata: ${Math.floor(rnd() * 40) + 5} kW`,
    ];
    return {
      category: 'connection_documents' as const,
      fileName: `seed-racordare-${pad(i + 1, 3)}.pdf`,
      displayName: `Document racordare ${requestNumber} (${documentType})`,
      mimeType: 'application/pdf',
      uploader: 'racordari' as const,
      metadata: {
        kind: 'connection',
        requestNumber,
        documentType,
        applicantName,
        cnp: cnp(),
        zone,
      },
      body: () => pdf(lines),
    };
  });
}

/** A 4 s test-pattern MP4 (about 100 KB), or null when ffmpeg is not installed. */
function testVideo(seconds: number, hue: number): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), 'filegrid-seed-'));
  const file = join(dir, 'zbor.mp4');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=duration=${seconds}:size=320x180:rate=15`,
        '-vf',
        `hue=h=${hue}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-y',
        file,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(file);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function videos(): SeedFile[] {
  const lines = [
    ['LEA 110 kV Constanța Sud - Medgidia', 'dobrogea'],
    ['LEA 110 kV Tulcea Vest - Isaccea', 'dobrogea'],
    ['LEA 110 kV Ploiești Nord - Buzău', 'muntenia'],
    ['LEA 110 kV Timișoara Nord - Lugoj', 'banat'],
  ] as const;
  return lines.map(([lineSection, zone], i) => {
    const fileName = `seed-zbor-${pad(i + 1, 2)}.mp4`;
    return {
      category: 'drone_videos' as const,
      fileName,
      displayName: fileName,
      mimeType: 'video/mp4',
      uploader: 'teren' as const,
      metadata: {
        kind: 'drone',
        lineSection,
        zone,
        inspectionDate: new Date(START + (i * 7 + 3) * DAY_MS).toISOString().slice(0, 10),
      },
      body: () => {
        const video = testVideo(4, i * 70);
        if (!video) throw new Error('ffmpeg is missing');
        return video;
      },
    };
  });
}

class ApiError extends Error {}

/** A logged-in user: the session cookie, sent with the CSRF header on every request. */
class Session {
  readonly username: string;
  private readonly cookie: string;

  private constructor(username: string, cookie: string) {
    this.username = username;
    this.cookie = cookie;
  }

  static async login(username: string, password: string | undefined): Promise<Session | null> {
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { username, password } : { username }),
    });
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .find((c) => c.startsWith('__Host-fg_session='));
    return response.ok && cookie ? new Session(username, cookie) : null;
  }

  async json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...CSRF,
        Cookie: this.cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new ApiError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return { status: response.status, data };
  }

  async part(uploadId: string, part: number, bytes: Buffer): Promise<void> {
    const response = await fetch(`${API}/uploads/${uploadId}/parts/${part}`, {
      method: 'PUT',
      headers: {
        ...CSRF,
        Cookie: this.cookie,
        'Content-Type': 'application/octet-stream',
        'X-Part-SHA256': sha256(bytes),
      },
      body: new Uint8Array(bytes),
    });
    if (!response.ok)
      throw new ApiError(`part ${part}: HTTP ${response.status} ${await response.text()}`);
  }
}

/** CLI output (stdout) and errors (stderr). */
const say = (line: string): void => void process.stdout.write(`${line}\n`);

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Display names of the seeded files already in a category (search `seed`, every page). */
async function existing(admin: Session, category: Category): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; ; page += 1) {
    const { data } = await admin.json(
      'GET',
      `/files?category=${category}&q=seed&pageSize=200&page=${page}`,
    );
    const rows = data.data as { displayName: string }[];
    rows.forEach((row) => names.add(row.displayName));
    if (!(data.meta as { hasMore: boolean }).hasMore) return names;
  }
}

/** Create, send every part with its SHA-256, complete (polling a slow completion). */
async function upload(session: Session, file: SeedFile): Promise<void> {
  const bytes = file.body();
  const created = await session.json(
    'POST',
    '/uploads',
    {
      category: file.category,
      fileName: file.fileName,
      fileSize: bytes.length,
      mimeType: file.mimeType,
      metadata: file.metadata,
    },
    { 'Idempotency-Key': `seed-${sha256(Buffer.from(file.fileName)).slice(0, 40)}` },
  );
  const { uploadId, chunkSize, partCount } = created.data as {
    uploadId: string;
    chunkSize: number;
    partCount: number;
  };
  for (let part = 1; part <= partCount; part += 1) {
    await session.part(uploadId, part, bytes.subarray((part - 1) * chunkSize, part * chunkSize));
  }
  let done = await session.json('POST', `/uploads/${uploadId}/complete`, {
    sha256: sha256(bytes),
    partCount,
  });
  for (let i = 0; done.status === 202 && i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    done = await session.json('GET', `/uploads/${uploadId}`);
    if (done.data.status === 'completed') break;
  }
  const verdict = (done.data.verdict ??
    (done.data.result as Record<string, unknown> | undefined)?.verdict) as string;
  if (verdict !== 'match') throw new ApiError(`${file.fileName}: verdict ${verdict ?? 'unknown'}`);
}

async function main(): Promise<void> {
  const admin = await Session.login('admin', process.env.SEED_ADMIN_PASSWORD);
  if (!admin) {
    throw new ApiError(
      `cannot log in as admin at ${BASE}: set SEED_ADMIN_PASSWORD (passwordless login is off)`,
    );
  }
  const sessions = new Map<Uploader, Session>([['admin', admin]]);
  const sessionFor = async (uploader: Uploader): Promise<Session> => {
    const known = sessions.get(uploader);
    if (known) return known;
    const session = (await Session.login(uploader, process.env.SEED_DEMO_PASSWORD)) ?? admin;
    if (session === admin) say(`  (no ${uploader} account: the admin uploads its files)`);
    sessions.set(uploader, session);
    return session;
  };

  const hasFfmpeg = testVideo(1, 0) !== null;
  const plan: [Category, SeedFile[]][] = [
    ['fault_records', faults()],
    ['connection_documents', connections()],
    ['drone_videos', hasFfmpeg ? videos() : []],
  ];
  if (!hasFfmpeg) say('ffmpeg is not installed: the drone videos are skipped');

  let uploaded = 0;
  let skipped = 0;
  for (const [category, files] of plan) {
    const there = await existing(admin, category);
    let added = 0;
    for (const file of files) {
      if (there.has(file.displayName)) continue;
      await upload(await sessionFor(file.uploader), file);
      added += 1;
    }
    uploaded += added;
    skipped += files.length - added;
    say(`${category}: ${added} uploaded, ${files.length - added} already there`);
  }

  const grid = await admin.json('GET', '/statistics/grid-insights');
  const byZone = (grid.data.faultsByZone as { zone: string; count: number }[])
    .map((z) => `${z.zone} ${z.count}`)
    .join(', ');
  say(`done: ${uploaded} uploaded, ${skipped} already there. Faults by zone: ${byZone}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
