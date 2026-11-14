/**
 * Proof for the PDF requirement "files over 1 GB are processed without the service's resources
 * growing with the file size": uploads about 1.1 GiB through the resumable API (create, parts with
 * X-Part-SHA256, complete), downloads it back and compares SHA-256, while sampling the memory of
 * every backend pod. The client holds only the parts in flight: the bytes are an AES-CTR keystream
 * generated part by part, and the download is hashed as it streams.
 *
 * Usage (Node 26 runs it as is), on the VPS, against the public domain:
 *   FILEGRID_URL=https://<host> \
 *   PROOF_MEMORY_CMD='kubectl -n filegrid top pod -l app=filegrid-backend --no-headers' \
 *   node scripts/proof-1gb-upload.ts
 * Optional: PROOF_SIZE_MIB (1126), PROOF_PARALLEL (2), PROOF_SAMPLE_S (5) and PROOF_ADMIN_PASSWORD
 * (when passwordless login is off; never printed). PROOF_MEMORY_CMD prints one line per pod with
 * the pod name first and a `<n>Mi` value (as kubectl top does). The file is a drone video named
 * test-p2-proof-1gb-*.bin; it stays stored (the API has no delete).
 */
import { execFile } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';

const BASE = (process.env.FILEGRID_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const CSRF = { 'X-Requested-With': 'filegrid' };
const MiB = 1024 * 1024;
const SIZE = Math.round(Number(process.env.PROOF_SIZE_MIB ?? 1126) * MiB);
const PARALLEL = Math.max(1, Number(process.env.PROOF_PARALLEL ?? 2));
const SAMPLE_MS = Math.max(1, Number(process.env.PROOF_SAMPLE_S ?? 5)) * 1000;
const MEMORY_CMD = process.env.PROOF_MEMORY_CMD;
/** The requirement: the backend's peak stays under its baseline + 64 MiB. */
const BUDGET_MIB = 64;
const COMPLETE_TIMEOUT_MS = 20 * 60_000;
const PART_ATTEMPTS = 5;

const say = (line: string): void => void process.stdout.write(`${line}\n`);
const seconds = (fromMs: number): string => ((performance.now() - fromMs) / 1000).toFixed(1);
const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Part `n` (1-based) of the test file: AES-256-CTR keystream, the same bytes on every run. */
const KEY = createHash('sha256').update('filegrid-proof-1gb').digest();
function partBytes(n: number, size: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(n, 0);
  return createCipheriv('aes-256-ctr', KEY, iv).update(Buffer.alloc(size));
}

type Phase = 'baseline' | 'upload' | 'complete' | 'download';
const ACTIVE: readonly Phase[] = ['upload', 'complete', 'download'];

/** Runs PROOF_MEMORY_CMD every PROOF_SAMPLE_S and keeps the peak MiB per pod and phase. */
class MemorySampler {
  phase: Phase = 'baseline';
  readonly peaks = new Map<string, Map<Phase, number>>();
  private timer: NodeJS.Timeout | undefined;

  sample(): Promise<void> {
    if (!MEMORY_CMD) return Promise.resolve();
    const phase = this.phase;
    return new Promise((resolve) => {
      execFile('sh', ['-c', MEMORY_CMD], { timeout: 15_000 }, (error, stdout) => {
        if (!error) this.record(phase, stdout);
        resolve();
      });
    });
  }

  private record(phase: Phase, output: string): void {
    for (const line of output.split('\n')) {
      const pod = line.trim().split(/\s+/)[0];
      const mib = /(\d+(?:\.\d+)?)Mi\b/.exec(line)?.[1];
      if (!pod || !mib) continue;
      const byPhase = this.peaks.get(pod) ?? new Map<Phase, number>();
      byPhase.set(phase, Math.max(byPhase.get(phase) ?? 0, Number(mib)));
      this.peaks.set(pod, byPhase);
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A markdown table: per pod, the baseline, the peak of each phase and the growth. */
  report(): string[] {
    if (!MEMORY_CMD) return ['(no PROOF_MEMORY_CMD: the backend memory was not sampled)'];
    if (this.peaks.size === 0) return ['(PROOF_MEMORY_CMD printed no `<n>Mi` value)'];
    const lines = [
      '| Backend pod | Baseline MiB | Upload peak | Complete peak | Download peak | Growth MiB | Under +64 MiB |',
      '|---|---|---|---|---|---|---|',
    ];
    for (const [pod, byPhase] of this.peaks) {
      const base = byPhase.get('baseline');
      const peak = Math.max(...ACTIVE.map((phase) => byPhase.get(phase) ?? 0));
      const cell = (phase: Phase): string => String(byPhase.get(phase) ?? '-');
      const growth = base === undefined ? '-' : String(peak - base);
      const ok = base === undefined ? '-' : peak - base < BUDGET_MIB ? 'yes' : 'NO';
      const cells = ACTIVE.map(cell).join(' | ');
      lines.push(`| ${pod} | ${cell('baseline')} | ${cells} | ${growth} | ${ok} |`);
    }
    return lines;
  }
}

class ApiError extends Error {}

async function login(): Promise<string> {
  const password = process.env.PROOF_ADMIN_PASSWORD;
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify(password ? { username: 'admin', password } : { username: 'admin' }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('__Host-fg_session='));
  if (!response.ok || !cookie) {
    throw new ApiError(`cannot log in as admin at ${BASE}: set PROOF_ADMIN_PASSWORD`);
  }
  return cookie;
}

async function call(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...CSRF,
      Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return {
    status: response.status,
    data: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** PUT one part with its SHA-256; a 5xx (storage hiccup, busy category) is retried with backoff. */
async function putPart(cookie: string, uploadId: string, n: number, bytes: Buffer): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${API}/uploads/${uploadId}/parts/${n}`, {
      method: 'PUT',
      headers: {
        ...CSRF,
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'X-Part-SHA256': sha256Of(bytes),
      },
      // A view on the same memory (no copy); cipher output is never a SharedArrayBuffer.
      body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length),
    });
    await response.arrayBuffer();
    if (response.ok) return;
    if (attempt >= PART_ATTEMPTS || response.status < 500) {
      throw new ApiError(`part ${n}: HTTP ${response.status}`);
    }
    await sleep(attempt * 2000);
  }
}

/** Every part, PARALLEL at a time, generated just before it is sent; returns the file SHA-256. */
async function uploadParts(
  cookie: string,
  uploadId: string,
  chunkSize: number,
  partCount: number,
): Promise<string> {
  const whole = createHash('sha256');
  const waiting = new Map<number, Buffer>();
  let next = 1;
  let hashed = 1;
  const worker = async (): Promise<void> => {
    while (next <= partCount) {
      const n = next;
      next += 1;
      const bytes = partBytes(n, Math.min(chunkSize, SIZE - (n - 1) * chunkSize));
      await putPart(cookie, uploadId, n, bytes);
      // The whole-file hash takes the parts in order: at most PARALLEL parts wait for it.
      waiting.set(n, bytes);
      for (let part = waiting.get(hashed); part; part = waiting.get(hashed)) {
        whole.update(part);
        waiting.delete(hashed);
        hashed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, partCount) }, worker));
  return whole.digest('hex');
}

/** POST complete; a large file answers 202 and is polled until the server has verified it. */
async function complete(
  cookie: string,
  uploadId: string,
  sha256: string,
  partCount: number,
): Promise<{ fileId: string; storage: string }> {
  let answer = await call(cookie, 'POST', `/uploads/${uploadId}/complete`, { sha256, partCount });
  const deadline = Date.now() + COMPLETE_TIMEOUT_MS;
  while (answer.status === 202 || answer.data.status === 'verifying') {
    if (Date.now() > deadline) throw new ApiError('the server did not finish verifying in 20 min');
    await sleep(2000);
    answer = await call(cookie, 'GET', `/uploads/${uploadId}`);
    if (answer.data.status === 'completed' || answer.data.status === 'failed') break;
  }
  const result = (answer.data.result as Record<string, unknown> | undefined) ?? answer.data;
  if (result.verdict !== 'match' || typeof result.fileId !== 'string') {
    throw new ApiError(`complete: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return {
    fileId: result.fileId,
    storage: typeof result.storage === 'string' ? result.storage : '?',
  };
}

/** Streams the download and hashes it as it arrives. */
async function download(
  cookie: string,
  fileId: string,
): Promise<{ sha256: string; bytes: number; header: string | null }> {
  const response = await fetch(`${API}/files/${fileId}/content`, {
    headers: { ...CSRF, Cookie: cookie },
  });
  if (!response.ok || !response.body) throw new ApiError(`download: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes, header: response.headers.get('x-file-sha256') };
}

async function createUpload(cookie: string, fileName: string) {
  const created = await call(
    cookie,
    'POST',
    '/uploads',
    {
      category: 'drone_videos',
      fileName,
      fileSize: SIZE,
      mimeType: 'application/octet-stream',
      metadata: {
        kind: 'drone',
        lineSection: 'Test 1 GB (P2 proof)',
        zone: 'banat',
        inspectionDate: new Date().toISOString().slice(0, 10),
      },
    },
    { 'Idempotency-Key': `proof-${sha256Of(Buffer.from(fileName)).slice(0, 40)}` },
  );
  return created.data as { uploadId: string; chunkSize: number; partCount: number };
}

async function main(): Promise<void> {
  const memory = new MemorySampler();
  await memory.sample();
  memory.start();
  try {
    const cookie = await login();
    const fileName = `test-p2-proof-1gb-${new Date().toISOString().replace(/[:.]/g, '-')}.bin`;
    say(`${(SIZE / MiB).toFixed(0)} MiB to ${BASE} as ${fileName}, ${PARALLEL} parts at a time`);

    memory.phase = 'upload';
    const started = performance.now();
    const { uploadId, chunkSize, partCount } = await createUpload(cookie, fileName);
    const sha256 = await uploadParts(cookie, uploadId, chunkSize, partCount);
    const uploadS = seconds(started);
    await memory.sample(); // every phase gets at least one sample, however short
    say(`  parts: ${partCount} x ${chunkSize / MiB} MiB in ${uploadS} s`);

    memory.phase = 'complete';
    const completing = performance.now();
    const { fileId, storage } = await complete(cookie, uploadId, sha256, partCount);
    const completeS = seconds(completing);
    await memory.sample();
    say(`  complete: verified and stored on ${storage} in ${completeS} s`);

    memory.phase = 'download';
    const downloading = performance.now();
    const back = await download(cookie, fileId);
    const downloadS = seconds(downloading);
    await memory.sample();
    const match = back.sha256 === sha256 && back.bytes === SIZE && back.header === sha256;
    say(`  download: ${(back.bytes / MiB).toFixed(0)} MiB in ${downloadS} s`);
    say(`SHA-256 ${match ? 'match' : 'MISMATCH'}: ${sha256}${match ? '' : ` vs ${back.sha256}`}`);
    say('');
    say(
      '| Size | Parts | Upload s | Complete s | Download s | Stored on | SHA-256 after download |',
    );
    say('|---|---|---|---|---|---|---|');
    const size = `${(SIZE / MiB).toFixed(0)} MiB`;
    const parts = `${partCount} x ${chunkSize / MiB} MiB`;
    const verdict = match ? 'match' : 'MISMATCH';
    say(
      `| ${size} | ${parts} | ${uploadS} | ${completeS} | ${downloadS} | ${storage} | ${verdict} |`,
    );
    say('');
    memory.report().forEach(say);
    if (!match) process.exitCode = 1;
  } finally {
    memory.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
