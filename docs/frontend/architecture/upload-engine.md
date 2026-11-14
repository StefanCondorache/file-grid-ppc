# Upload engine: architecture

*Status: DRAFT for review (2026-11-14). Covers FE-02, FE-04 (download verification), FE-18 (mock), and the server contract for BA-10..BA-15 and BA-65. Answers OQ-1 and OQ-2.*

*Reconciled with the other agents (details in [docs/adr/](../../adr/README.md); where an ADR differs, the ADR wins): chunk cap 32 MiB instead of 50 MiB (ADR-0005); API base `/api/v1` (ADR-0002); CSRF header `X-Requested-With: filegrid` (ADR-0006); on a `202` from `complete` the engine polls `GET /uploads/{id}` and also treats the SSE `upload.verified` event as a hint to poll immediately (ADR-0003).*

## 1. Recommendation in one paragraph

Use a **custom chunk API** (create, `PUT` part, status, complete, delete) with **hash-first, then parallel part upload**. The browser hashes the file once in a Web Worker (hash-wasm), keeps per-part SHA-256 values, and uploads parts in parallel over XHR. Progress, resume state and the file handle live in IndexedDB. After F5 on Chrome, the engine reopens the file from a stored `FileSystemFileHandle` (0 or 1 click). On other browsers the user re-selects the file once and the engine checks it is the same one. The server verifies each part while streaming it and computes the whole-file SHA-256 by reading the stored parts back in order at `complete`. It does not need in-order arrival.

## 2. tus vs custom chunk API (OQ-2)

| Criterion | (a) tus (`tus-js-client` + `@tus/server`) | (b) Custom chunk API | Edge |
|---|---|---|---|
| Parallel chunks | Core is sequential `PATCH`. Parallelism needs the concatenation extension: N partial uploads are created up front, then one final concat request. N is fixed at start, and resume state is a set of upload URLs. The policy field "max parallel chunks" (BA-15, FE-06) is ignored by plain tus. | Native. Each part is an independent idempotent `PUT`. Parallelism is a client scheduler setting that the policy can change. | b |
| NestJS effort | Mount `@tus/server` as middleware inside Nest. Write a custom DataStore for FTP and Postgres (S3 store exists). Wire auth, trace ID, policy snapshot and per-upload authorisation (BA-65) through tus hooks. The backend must learn tus internals. | 5 plain controllers. S3 maps 1:1 to multipart (`UploadPart`, `CompleteMultipartUpload`). Normal Nest code, easy to trace and log. | b (slight) |
| Server SHA-256 | Sequential offsets mean the server hashes incrementally while streaming, with no read-back. This is tus's real advantage. The tus checksum extension is per request and only covers the algorithms the server lists. | Out-of-order parts cannot feed one incremental hash. Solved by per-part verify plus an in-order read-back at `complete` (section 12). The read-back also proves what is actually stored (F4). | a, narrowly |
| Storage fan-out | S3: `@tus/s3-store` is multipart. FTP: sequential append fits well. Postgres: custom. | S3: native multipart. FTP and Postgres: parts staged on local disk, assembled in order at `complete`, streamed to the target. This costs temporary disk, not memory. | tie |
| Mockability | The mock must emulate `HEAD`, `PATCH` offsets, `Upload-Offset` and `Tus-Resumable` semantics. Doable, but protocol-heavy. | Five JSON/binary endpoints, trivial MSW handlers. | b |
| Library dependence in the frontend | `tus-js-client` owns retry, offset and fingerprint storage (in `localStorage`). We would still build the state machine, offline detection, hashing, IndexedDB, file reopen, speed and ETA. The library is hard to bend to the Romanian state machine. | Zero upload library. About 600 lines of our own engine, fully unit-testable with fake timers. | b |
| Cloudflare 100 MB body | Default `chunkSize` is `Infinity`, which is one huge `PATCH` and would be rejected with 413. It must be set explicitly. | Chunk size is a first-class, clamped field. | b |
| Time to first working demo | A library gets sequential upload going fastest. | Needs a mock and an agreed contract, which D7 already requires. | a (small) |

**Decision (UE-1): custom chunk API.** The deciding factors are the policy-driven parallelism the brief and PRD require, the 1:1 mapping to S3 multipart, the mockability (D7), and the frontend owning its resilience behaviour. The cost is that the backend writes a small API and the frontend writes its own state machine. Both are inside the effort budget, and tus would not remove either. The tus in-order hashing advantage is neutralised by the read-back, which also adds storage-level proof.

## 3. Components and module boundary

```
frontend/src/features/upload/
  engine/                      # framework-free TS, no React, no Next imports
    engine.ts                  # UploadEngine: public API, wires everything
    machine.ts                 # pure transition function + table (section 11)
    scheduler.ts               # part queue, concurrency (AIMD), retry, backoff
    backoff.ts                 # full-jitter delay function (pure)
    net.ts                     # online/offline detector + probe
    progress.ts                # throughput EMA, ETA, throttled emit
    policy.ts                  # snapshot capture, clamping, validation
    pii.ts                     # allowlist of persistable metadata fields
    types.ts
    ports.ts                   # UploadApi, PartTransport, UploadRepo, HashClient, Clock, Rng
  infra/
    xhr-part-transport.ts      # PartTransport over XMLHttpRequest
    idb-upload-repo.ts         # IndexedDB repo
    hash-client.ts             # main-thread proxy for the worker
    hash.worker.ts             # hash-wasm + WebCrypto, file hash and download hash
    file-access.ts             # FileSystemFileHandle / picker / drop helpers
  store/
    upload-store.ts            # Zustand adapter: engine snapshot -> tray state
  ui/ ...                      # tray, drop zone (owned elsewhere)
frontend/src/features/upload/download/
  verified-download.ts         # section 15
frontend/src/mocks/upload-handlers.ts   # MSW handlers for this protocol (section 16)
```

The typed API client (generated from OpenAPI) implements `UploadApi`. The engine never builds URLs itself. Only `infra/` touches browser APIs, so `engine/` is unit-testable in Node with fakes.

## 4. Public API of the engine

```ts
export type UploadState =
  | 'queued' | 'hashing' | 'uploading' | 'paused'
  | 'connection_lost' | 'verifying' | 'verified' | 'failed';

export type PauseReason = 'user' | 'auth' | 'needs_file';
export type FailReason =
  | 'checksum_mismatch'   // "Amprenta nu coincide"
  | 'policy_violation' | 'too_large' | 'file_changed' | 'forbidden'
  | 'upload_gone' | 'storage_unavailable' | 'retries_exhausted' | 'unknown';

export interface UploadSnapshot {
  localId: string;                 // client UUID
  uploadId: string | null;         // server ID once created
  state: UploadState;
  pauseReason?: PauseReason;
  failReason?: FailReason;
  retryAt?: number;                // epoch ms, when state = connection_lost with a timer
  offline?: boolean;               // connection_lost because offline, no countdown
  category: Category;
  displayName: string;             // safe label (never PII for connection docs)
  sizeBytes: number;
  confirmedBytes: number;          // bytes of confirmed parts
  inFlightBytes: number;           // partial progress of in-flight parts
  hashedBytes: number;             // for the hashing phase
  speedBps: number | null;         // EMA
  etaSec: number | null;
  startedByRole: Role;             // tray shows who started it (FE-01)
  policyVersion: number;           // snapshot, shown in the tray
  clientSha256?: string;
  result?: CompleteResult;
  error?: { code: string; message: string; traceId?: string };
}

export interface EnqueueInput {
  category: Category;
  file: File;
  fileHandle?: FileSystemFileHandle;                // Chromium only
  metadata: Record<string, string>;                 // may contain PII; allowlist applied before persistence
}

export type EngineEvent =
  | { type: 'snapshot'; uploads: readonly UploadSnapshot[] }   // throttled, <= 4 Hz for progress, immediate for transitions
  | { type: 'announce'; localId: string; message: string }     // a11y cadence, section 14
  | { type: 'completed'; localId: string; result: CompleteResult };

export interface UploadEngine {
  restore(): Promise<void>;                          // call once on boot, after whoami
  enqueue(input: EnqueueInput): Promise<string>;     // returns localId
  pause(localId: string): void;
  resume(localId: string): void;
  cancel(localId: string): Promise<void>;
  retry(localId: string): void;                      // from `failed` when resumable
  attachFile(localId: string, file: File, handle?: FileSystemFileHandle): Promise<'ok' | 'different_file'>;
  grantFileAccess(localId: string): Promise<void>;   // requestPermission() from a click, then reopen
  notifySession(s: 'expired' | 'valid'): void;       // fed by the auth layer
  getSnapshot(): readonly UploadSnapshot[];          // for useSyncExternalStore
  subscribe(l: (e: EngineEvent) => void): () => void;
  dispose(): void;
}

export interface EngineDeps {
  api: UploadApi; transport: PartTransport; repo: UploadRepo; hash: HashClient;
  clock: Clock; rng: () => number; net: NetMonitor; currentUser: () => { id: string; role: Role };
}
```

## 5. Policy, chunk size and parallelism (BA-15, FE-06)

The policy snapshot is captured at `enqueue` from `GET /policies` (BA-05) for client-side pre-validation. The `POST /uploads` response is authoritative (`chunkSize`, `maxParallel`, `policyVersion`) and replaces the pre-create values. It is persisted in the upload record and **never refreshed**. A policy edit during an upload (beat 7) therefore changes nothing for it, and the tray says "Politica v3 (la pornire)".

```ts
export interface PolicySnapshot {
  category: Category; policyVersion: number; capturedAt: string;
  chunkSize: number; maxParallel: number; maxFileSize: number; allowedTypes: string[];
}
```

| Rule | Value | Why |
|---|---|---|
| Hard chunk cap | 32 MiB (`MAX_PART = 32 * 2**20`) | Cloudflare free plan body limit is 100 MB; 32 MiB leaves 3x headroom and keeps a part under Traefik's read timeout on a slow link (ADR-0005; the agent first proposed 50 MiB). |
| Chunk floor | 5 MiB, except the last part | S3 multipart minimum part size. |
| Chunk used | `clamp(policy.chunkSize, 5 MiB, 32 MiB)`. The server also raises it to `ceil(size / 10000)` (S3 max 10,000 parts). | The client sends it as `requestedChunkSize` and uses whatever the server echoes. Part numbering is fixed for the life of the upload. |
| Parallelism | `clamp(policy.maxParallel, 1, 6)` as the ceiling | 6 matches the HTTP/1.1 per-origin limit, so it is safe even if Cloudflare falls back from HTTP/2. |
| Starting concurrency | `min(ceiling, 2)` | Slow start, then AIMD (section 6). |
| Suggested policy defaults | drone 8 MiB x 4 parallel; faults 8 MiB x 2; connection docs 8 MiB x 2 | At 2 Mbit/s uplink an 8 MiB part takes about 34 s, comfortably below any timeout. |
| Validation before create | size, MIME and extension against the snapshot. A violation is rejected locally with the reason; the server re-validates. | FE-02. |

Memory bound: in-flight bytes are at most `concurrency x chunkSize` as lazy `Blob` slices (about 32 MiB at 4 x 8 MiB), not materialised in JS. The worker holds at most one chunk plus its digest input (about 16 MiB) at a time.

## 6. Scheduler, retry and backoff

```ts
export interface PartTransport {
  send(args: {
    uploadId: string; partNumber: number; body: Blob; sha256Hex: string;
    stallMs: number; signal: AbortSignal; onProgress(sentBytes: number): void;
  }): Promise<PartResult>;   // resolves with status + parsed body, or rejects with NetworkError
}
export const backoffMs = (attempt: number, rng: () => number, base = 1000, cap = 30000) =>
  Math.floor(rng() * Math.min(cap, base * 2 ** attempt));   // full jitter
```

Scheduler loop, run on every event:

1. `pump()` runs only when `state = uploading`, the net monitor says online, and the session is valid.
2. While `inFlight < concurrency`, pick the next part: due retries first, then the lowest unconfirmed part number.
3. Create the slice `file.slice(offset, offset + size)` at send time. No arrays of slices are kept.
4. `sha256Hex` comes from the persisted hash table.
5. Send via `PartTransport`.
6. On success: mark the part confirmed in IndexedDB (one small write), reset that part's attempts, and set `concurrency = min(ceiling, concurrency + 1)` after every 4 consecutive successes.
7. On a retryable failure: set `concurrency = max(1, floor(concurrency / 2))`. Schedule `retryAt = now + backoffMs(attempt)` for that part.
8. When all confirmed: go to `verifying` and call `complete`.

Transport: **XHR for part PUTs** (upload progress events, abort, stall watchdog), `fetch` for JSON calls. A part is aborted if no progress event arrives for 30 s, or after 120 s total. Aborted parts are retried like network errors.

Status handling:

| Outcome | Class | Action |
|---|---|---|
| Network error, XHR abort or stall, `status 0` | retryable | Backoff. Counts toward attempts only while `navigator.onLine` is true. |
| 408, 425, 429 | retryable | Honour `Retry-After` if present (take the larger of that and the backoff). |
| 500, 502, 503, 504, Cloudflare 520..524 | retryable | Backoff. On 503 `STORAGE_UNAVAILABLE` the error text names the storage (FE-08); retries continue. |
| 401 | pause | `paused(auth)`. In-flight parts are aborted without counting an attempt. The auth layer shows the login. On `notifySession('valid')` the engine resumes. The same user is required (BA-65). |
| 403 | fatal | `failed(forbidden)`. Includes "different real user". |
| 404 `UPLOAD_NOT_FOUND` | fatal | `failed(upload_gone)`. The UI offers "Reîncepe" (new create, same file, new client key). |
| 409 `UPLOAD_NOT_OPEN` | reconcile | `GET /uploads/{id}`. If `completed`, adopt the result. If `aborted` or `expired`, `failed(upload_gone)`. Never retried blindly. |
| 413 | fatal | `failed(too_large)`. Also hit if a Cloudflare 413 appears, which means a clamp bug. |
| 422 `PART_CHECKSUM_MISMATCH` | retry 3x, then fatal | The data may have been corrupted in transit, or the file changed on disk. After 3 attempts, `failed(file_changed)`. |
| 422 other, 400 | fatal | `failed(policy_violation)` or a validation message. |

Limits:

- Max 10 attempts per part. When exhausted, the upload goes to `failed(retries_exhausted)`. It stays **resumable**: the server still holds the parts, and a "Reia" button calls `retry()` with counters reset. This keeps "no manual intervention" true for any outage under about 5 minutes online-failing, while a truly dead link ends visibly.
- While offline nothing counts: the upload waits indefinitely, since offline pause is not a failure.
- The "conexiune pierdută, reîncercare în N s" state is entered when at least one retry is scheduled and **no part is actively sending**. `retryAt = min(next part retryAt)`. The UI computes N from `retryAt` with its own 1 s tick, and the engine emits nothing per second. Any successful part moves the upload back to `uploading`.

## 7. Online/offline detection and auto-pause/resume

```ts
export interface NetMonitor {
  readonly online: boolean;
  subscribe(l: (online: boolean) => void): () => void;
  reportNetworkError(): void;   // heuristic input from transport
  reportSuccess(): void;
}
```

- `navigator.onLine === false` is reliable (the device has no link). `true` is not (captive portal, dead Wi-Fi).
- `offline` event: set `online = false` immediately and abort all in-flight XHRs (otherwise they hang until a TCP timeout). Move to `connection_lost` with `offline: true` and no countdown ("reluăm automat").
- `online` event: do not trust it; start probing.
- Heuristic: 2 network errors within 5 s on different parts, or any network error while `onLine` is true after an `online` event, means `online = false` (suspect). Stop launching parts.
- Probe: `HEAD /api/v1/ping` (204, no auth, `cache: 'no-store'`, 3 s timeout) on a `backoffMs` schedule (base 1 s, cap 15 s), starting immediately on the `online` event. First success sets `online = true`, which resumes all `connection_lost` uploads (no click) and restarts at the lowest concurrency.
- Multi-tab: one tab drives an upload via `navigator.locks.request('upload:' + localId, { ifAvailable: true })`. Another tab shows it read-only.
- A hidden tab keeps XHR running, but Chrome throttles chained timers. Retry delays can stretch in background tabs. Acceptable; noted in risks.

## 8. Resume after reload (OQ-1)

### 8.1 What is persisted in IndexedDB (`filegrid-uploads`, v1)

```ts
export interface PersistedUpload {
  localId: string;
  userId: string;                    // real user; records of other users are ignored on boot (BA-65)
  startedByRole: Role;
  clientKey: string;                 // Idempotency-Key for create, written BEFORE the POST
  uploadId: string | null;
  category: Category;
  state: UploadState; pauseReason?: PauseReason;
  fingerprint: { nameHash: string; name?: string; size: number; lastModified: number; type: string };
  policy: PolicySnapshot;            // frozen at start
  chunkSize: number; partCount: number;
  fileSha256?: string;               // hex, once hashing is done
  partSha256?: Uint8Array;           // 32 bytes x partCount, once hashing is done
  confirmed: Uint8Array;             // bitset, one bit per part
  hashCheckpoint?: { offset: number; state: Uint8Array };   // optional P2, see 9.3
  safeMetadata: Record<string, string>;                     // allowlisted fields only
  displayName: string;
  createdAt: number; updatedAt: number;
}
// separate store 'handles': { localId, handle: FileSystemFileHandle }  (Chromium)
```

**Never persisted:** file bytes, the `File` object, cookies or tokens, any PII field.

### 8.2 Personal data

Connection documents carry applicant name, CNP and possibly an address, and the file name can embed them ("CI_Popescu_Ion.pdf").

- `pii.ts` holds a per-category allowlist of persistable metadata fields. Anything not on it is dropped before the first IndexedDB write. PII fields are kept in memory only until the `POST /uploads` call returns, then released. Resume never needs them: the server already has them from create.
- Allowed per category: fault (`zone`, `substation`, `eventTime`, `severity`); drone (`line`, `zone`, `inspectionDate`); connection documents (`requestNumber`, `documentType`). The request number is treated as non-PII (FE-13 permits searching by it).
- For connection documents the file name is **not stored**. Only `nameHash = SHA-256(name)` is kept. The tray label is the server's display-safe name (BA-17) or "Document racordare nr. {requestNumber}" before create returns.
- **Decision for PII categories: no persisted file handle.** These files are 0.1 to 10 MB and finish in seconds. After a reload the user re-selects the file (fallback 8.4). This avoids storing a reference to a local file path alongside an identity document.
- On logout: the records stay (FE-01: queue metadata survives), but records are only shown to the same `userId`. A 7-day TTL purge runs at boot.

### 8.3 Can the File be reopened after reload? Evaluation

| Option | Works? | Confidence | Verdict |
|---|---|---|---|
| Store the `File` in IndexedDB | A `File` is structured-cloneable, so the `put` succeeds. In Chromium, IndexedDB persists blobs by writing them into its own blob store, which likely **copies the bytes** (1 GB of disk and quota, a slow write, and a copy of what we promised not to store). I could not verify that file-backed blobs are stored by reference. The read-back `File` would be a snapshot, not a live view. | Low on "by reference", medium on "copies". | **Rejected.** Even if it were by reference, we should not bet beat 2 on undocumented behaviour. |
| `FileSystemFileHandle` in IndexedDB (Chromium) | Handles are storable. After reload `queryPermission({ mode: 'read' })` normally returns `'prompt'`. `requestPermission()` needs transient user activation (a click) and shows a small prompt. Since Chrome 122 the prompt offers "Allow on every visit", after which `queryPermission` returns `'granted'` on later loads and the whole resume is click-free. `handle.getFile()` returns a fresh `File`, which we verify. | High that it works with at most one click. Medium that "Allow on every visit" is offered and sticks on the exact Chrome version at the venue. | **Primary path.** |
| Obtaining a handle | `showOpenFilePicker()` for the picker button. For drag-and-drop, `DataTransferItem.getAsFileSystemHandle()` (Chromium) returns a handle for dropped files, so drag-and-drop in beat 2 also yields one. `<input type=file>` gives no handle. | High | Use handle APIs when present, else `<input>` plus the fallback. |
| Re-select, then verify it is the same file | Works in every browser. | High | **Fallback path.** |

### 8.4 Identity check on reopen

1. Reopen via `handle.getFile()`, or via the user re-selecting or dropping a file.
2. Compare `name` (or `nameHash`), `size` and `lastModified` with the fingerprint.
3. If these match, re-hash 3 sampled parts (first, last, and the middle one) in the worker and compare with the persisted `partSha256`. That is at most 24 MiB, well under a second.
4. `ok`: continue uploading. `different_file`: show "Acesta nu este același fișier" and offer to attach another file or start a new upload.
5. Any file dropped or selected anywhere in the app whose fingerprint matches a `needs_file` record auto-attaches.
6. A sampled-part mismatch is not the only guard: the server's per-part SHA-256 check (422) catches any later divergence.

### 8.5 Clear answer for beat 2 on Chrome

**Yes, the file can be reopened without a file dialog.** The presenter drags the 1 GB file in (handle stored). After F5 the tray is restored in `paused(needs_file)`.

- **Rehearsed path, 0 clicks:** during the first run of the beat the presenter picks "Allow on every visit" on the Chrome prompt. This means that on boot `queryPermission` returns `granted`, the engine reopens the handle, verifies the sampled parts, and continues from the same percent with no input.
- **Worst case, 1 click:** a "Continuă încărcarea" button on the row calls `grantFileAccess()`. Narrate it as "verificăm că e același fișier".
- **Safari/Firefox or an `<input>` selection:** re-select once.

Rehearsal must confirm this on the exact Chrome version and profile used at the venue (checklist, section 18).

## 9. Hashing: incremental SHA-256 in a Web Worker

### 9.1 Order: hash first, then upload in parallel

| Option | Verdict |
|---|---|
| Hash while uploading, in order | The whole-file hash then depends on in-order progress, and per-part checksums needed for `PUT` force a lookahead anyway. After a reload the hash state is lost unless checkpointed. Complex. |
| **Hash first (one pass), then upload** | **Chosen.** One sequential pass produces `fileSha256` and all `partSha256` values. Both are persisted before the first byte is sent. Reload never re-hashes: the persisted values are final. Simplest resume story. |

### 9.2 Worker protocol

```ts
type HashIn =
  | { t: 'hashFile'; job: number; file: Blob; partSize: number }
  | { t: 'samplePartHashes'; job: number; file: Blob; partSize: number; parts: number[] }
  | { t: 'hashStream'; job: number; ... }          // download, section 15
  | { t: 'abort'; job: number };
type HashOut =
  | { t: 'progress'; job: number; bytes: number }
  | { t: 'fileDone'; job: number; fileSha256: string; partSha256: Uint8Array }
  | { t: 'sampleDone'; job: number; hashes: Record<number, string> }
  | { t: 'error'; job: number; message: string };
```

- The worker is passed the `File`, which is structured-clone cheap (a reference, not bytes). It slices `file.slice(i * partSize, (i + 1) * partSize).arrayBuffer()` one part at a time and, per part, calls `hasher.update(new Uint8Array(buf))` on the **hash-wasm `createSHA256()`** instance (file hash) and `crypto.subtle.digest('SHA-256', buf)` (per-part hash, native). `abort` is checked between parts.
- Why both: WebCrypto cannot hash incrementally, so hash-wasm is needed for the whole file. It is cheaper to use native WebCrypto for the one-shot per-part digest than to run hash-wasm twice.
- Progress messages are throttled to 10 per second.
- The bundle imports `hash.worker.ts` via `new Worker(new URL(...), { type: 'module' })`. hash-wasm inlines its WASM, which means the CSP needs `'wasm-unsafe-eval'` in `script-src` (and `worker-src 'self'`). Flag for the CSP/threat-model doc.

### 9.3 Throughput and UX

| Item | Estimate | Confidence |
|---|---|---|
| hash-wasm SHA-256 | 250 to 450 MB/s on a modern laptop | Medium. Benchmark on the demo machine in milestone 5. |
| WebCrypto per-part digest | 1 GB/s or better | Medium |
| Disk read via `Blob.slice` | 0.5 to 2 GB/s on SSD | Medium |
| 1 GB total hashing pass | **about 3 to 8 s** | Medium |

UX impact: the row shows "se calculează amprenta" with a progress bar for a few seconds before the first byte moves. It never blocks the main thread. The pass is short enough to fit inside beat 2's narration ("Hash computed in background").

Hasher-state persistence: hash-wasm `save()` / `load()` exist (confidence high on the API; not tested here). They would let a reload during the hashing pass resume from the last checkpoint. Not built in v1 because the pass is under 10 s, hash-first persists only final values, and a reload during those seconds just restarts hashing. If time remains, checkpoint every 64 MiB into `hashCheckpoint` (P2).

## 10. Constant memory

| Rule | Implementation |
|---|---|
| Never read the whole file | No `FileReader`, no `file.arrayBuffer()`, no `new Response(file)`. Lint rule bans `FileReader` and unbounded `.arrayBuffer()` under `features/upload`. |
| Slice lazily | `Blob.slice` per part at send time. The XHR body is the `Blob`, so Chrome reads it from disk during the send. The JS heap holds no copy. |
| Worker memory | At most one part (<= 16 MiB, typically 8) plus its digest buffer; buffers are dropped after each iteration. |
| Bound | `concurrency x chunkSize` of lazy blob references (about 32 MiB for 4 x 8 MiB) plus about 16 MiB in the worker. Independent of file size. |
| Release | No arrays of parts, `Blob`s or `ArrayBuffer`s are kept on engine state. `partSha256` is 32 bytes per part (4 KB for 1 GB at 8 MiB). |
| Evidence | Chrome Task Manager (tab memory) during a 1 GB+ upload. Target under 300 MB. Against mocks, MSW reads each part into the page, so only transient, bounded growth appears there. The flatness proof is valid only against the real backend (section 18). |

## 11. State machine

States and copy (Romanian, comma-below diacritics):

| State | Copy |
|---|---|
| `queued` | în așteptare |
| `hashing` | se calculează amprenta |
| `uploading` | se încarcă |
| `paused` (`user` / `auth` / `needs_file`) | în pauză (with the reason) |
| `connection_lost` | conexiune pierdută, reîncercare în N s (or "reluăm automat" when offline) |
| `verifying` | se verifică |
| `verified` | verificat |
| `failed` | eșuat (reason and trace ID) |

Transition table (`machine.ts` is a pure function `(state, event) => { state, effects }`):

| From | Event | To | Effect |
|---|---|---|---|
| (none) | ENQUEUE | `queued` | persist record (without PII), write `clientKey` |
| `queued` | SLOT_FREE (max 2 hashing/creating at once) | `hashing` | start worker job |
| `queued`/`hashing` | FILE_MISSING (after restore) | `paused(needs_file)` | show "Continuă" |
| `hashing` | HASH_DONE | `uploading` | persist hashes, `POST /uploads` (idempotent), `GET` received parts, start scheduler |
| `hashing` | HASH_ERROR | `failed(file_changed)` or `unknown` | |
| `uploading` | PART_OK (not last) | `uploading` | persist bitset |
| `uploading` | ALL_PARTS_OK | `verifying` | `POST /complete` |
| `uploading` | RETRY_SCHEDULED and no part sending | `connection_lost` (`retryAt`) | |
| `uploading` | OFFLINE | `connection_lost` (`offline`) | abort in-flight |
| `connection_lost` | PART_OK / RETRY_FIRES | `uploading` | |
| `connection_lost` | ONLINE_CONFIRMED (probe ok) | `uploading` | resume scheduler |
| `uploading`/`connection_lost`/`hashing` | USER_PAUSE | `paused(user)` | abort in-flight; server keeps parts |
| `paused(user)` | RESUME | `uploading` (or `hashing` if hashes missing) | |
| any active | SESSION_EXPIRED (401) | `paused(auth)` | |
| `paused(auth)` | SESSION_VALID (same user) | previous state | |
| `paused(needs_file)` | FILE_ATTACHED(ok) | `uploading` or `hashing` | |
| `paused(needs_file)` | FILE_ATTACHED(different) | stays | message |
| `verifying` | COMPLETE_OK(match) | `verified` | emit `completed` |
| `verifying` | COMPLETE_OK(mismatch) | `failed(checksum_mismatch)` | "Amprenta nu coincide"; file not available |
| `verifying` | COMPLETE 202 | `verifying` | poll `GET` every 2 s |
| `verifying` | COMPLETE 409 PARTS_MISSING | `uploading` | requeue missing parts |
| any active | FATAL(code) | `failed(reason)` | persist reason |
| `failed` | RETRY (if resumable) | `uploading` | reset attempt counters |
| any non-terminal | CANCEL | removed | `DELETE /uploads/{id}`, delete the record and handle |
| after reload | restore | `queued` (never `uploading` directly) | re-enter via `hashing` or `uploading` once the file is reopened |

`verified` and `failed(non-resumable)` are terminal.

## 12. Idempotency and the server hash

- **Create:** the client generates `clientKey` (UUID) and writes it to IndexedDB **before** the call. The request carries `Idempotency-Key`. If the tab dies mid-create, the replay returns the same `uploadId` (HTTP 200, `Idempotent-Replayed: true`).
- **Part:** re-sending part `n` with the same checksum returns 200 with `alreadyReceived: true` and does no work. A different checksum for the same `n` before `complete` replaces the part.
- **Complete:** safe to repeat. After success it returns the same result. After failure it returns the same failure.
- **Delete:** idempotent. 404 counts as success on the client.

**Server-side hashing with out-of-order parts (the answer):**

1. On each `PUT`, the server hashes the part bytes **while streaming them to storage** and compares with `X-Part-SHA256`. A mismatch gives 422 and the part is not recorded. This is a per-part integrity gate and runs in constant memory.
2. At `complete`, the server computes the whole-file SHA-256 by **streaming the parts in order** and feeding one `crypto.createHash('sha256')`:
   - S3: after `CompleteMultipartUpload`, `GetObject` stream into the hash, or read parts individually via ranged `GET`.
   - FTP and Postgres: the staged parts are read in order and piped to the target. The same pass computes the hash and (for connection documents) feeds the streaming encryption, so no extra read is needed.
3. The comparison is against the client's `sha256` from the `complete` body. For S3 the read-back verifies the **stored object**, which is stronger than hashing the stream in flight (F4: proof of what is stored).
4. Cost: one extra sequential read of the file at `complete`. For 1 GB from local SeaweedFS this is about 2 to 6 s (assumed, to be measured by the backend). Since that can approach the proxy timeout on slower disks, `complete` may answer `202` with `status: 'verifying'` and the client polls `GET` (section 17).
5. Opportunistic in-order hashing during upload was considered and rejected: with 4 parallel parts the order is not guaranteed, and a node `Hash` cannot be checkpointed. It adds complexity for a small saving.

## 13. Final verification (F4, BA-13)

`POST /complete` carries the client `sha256`. The response (`CompleteResult`) gives `serverSha256`, `verdict`, `fileId`, `storage` label, `policyVersion` and, for faults, availability time.

```ts
export interface CompleteResult {
  status: 'completed' | 'failed';
  verdict: 'match' | 'mismatch';
  fileId: string | null;               // null when mismatch: the file is NOT available
  clientSha256: string; serverSha256: string;
  size: number;
  storage: 'S3' | 'FTP' | 'DB';        // label only, never a URL
  usedFallback: boolean;
  policyVersion: number;
  encryptedAtRest: boolean;
  availableAt?: string;                // ISO UTC, faults
  availableAfterMs?: number;           // upload-complete to listable, faults ("în 1,2 s")
  traceId: string;
}
```

The UI shows both hashes side by side. On `mismatch`, the upload becomes `failed(checksum_mismatch)` with "Amprenta nu coincide" and the file is not linked or listed as available. On `match`, the tray row becomes `verified` with a link to the file detail and, for faults, "Disponibil pentru dispecerat în {availableAfterMs} s".

## 14. Progress, speed, ETA, UI cadence

- **Progress** = `(confirmedBytes + inFlightBytes) / size`. `inFlightBytes` comes from XHR `upload.onprogress` per part. While hashing, progress is `hashedBytes / size`.
- **Speed (EMA):** sample every 500 ms, `instant = Δbytes / Δt`, `speed = 0.2 * instant + 0.8 * speed` (time constant about 2.5 s). Null for the first 3 s. Reset to null after a pause or `connection_lost`, so a stale speed never shows.
- **ETA** = `remaining / speed`, shown only while `uploading` and above 3 s of data. Smoothed with a second EMA (alpha 0.3). Capped at "mai mult de 24 h".
- **Emit cadence:** transitions are emitted immediately. Progress, speed and ETA are coalesced into one `snapshot` at **4 Hz** (250 ms) per engine, not per XHR event.
- **React:** `upload-store.ts` holds `uploads` keyed by `localId`. Rows subscribe with selectors so only the changed row re-renders. The tray reads `getSnapshot()` through `useSyncExternalStore`.
- **Live-region announcements** (a11y owner decides wording). The engine emits `announce` events with these rules: on state change; at 25 / 50 / 75 / 100 %; and for `connection_lost` once per outage (not per retry). At most one announce per upload per 10 s. No per-percent or per-second announcements.

## 15. Download verification (FE-04)

```ts
export type DownloadMode = 'client_verified' | 'verify_only' | 'server_verified';
export interface VerifiedDownloadResult {
  mode: DownloadMode;
  badge: 'Verificat' | 'Verificat de server' | 'Neverificat' | 'Fișier corupt detectat';
  expectedSha256: string; actualSha256?: string; traceId?: string;
}
export function downloadAndVerify(args: {
  fileId: string; size: number; expectedSha256: string;
  onProgress(b: number): void; signal: AbortSignal;
}): Promise<VerifiedDownloadResult>;
```

Streaming loop (constant memory): `fetch(contentUrl)`, then `response.body.getReader()`. For each chunk: write it to the sink, then transfer it to the hash worker (zero-copy). Keep at most 4 unacknowledged chunks in flight as backpressure. The worker feeds hash-wasm and returns the digest at the end. No `tee()` (it can buffer unboundedly).

| File size / browser | Behaviour | Memory |
|---|---|---|
| <= 64 MiB, any browser | Accumulate chunks into a `Blob`, hash, then save via an anchor download. Covers the beat 6 fault record. | <= 64 MiB |
| > 64 MiB, Chromium | `showSaveFilePicker()` (needs the click gesture) gives a `FileSystemWritableFileStream` sink. Bytes go to disk as they arrive; the hash is computed in parallel. Badge: `Verificat` or `Fișier corupt detectat`. | constant |
| > 64 MiB, other browsers | Plain anchor download (the browser streams to disk itself). No client hash. Badge: `Verificat de server`; the UI states that the check was done by the server. | constant |
| Any size, "Verifică fără a salva" | Same loop, sink discarded. Verifies and tells the user, saves nothing. | constant |

Trade-offs, stated plainly: in non-Chromium browsers there is no streaming save without a service worker, and we do not build one. Client re-verification of files over 64 MiB therefore needs Chromium. Everywhere else the server verification is shown and labelled.

Corruption: the badge `Fișier corupt detectat` appears when `actualSha256 !== expectedSha256`, showing both hashes, the storage and the trace ID. The backend must pre-verify and answer `409 FILE_CORRUPT` with body `{expectedSha256, actualSha256, storage}` when it can detect it before streaming (BA-18). Where it cannot (large files), the client hash catches it at the end. A response that aborts mid-body is treated as a network error and retried; a retried download whose hash still differs is flagged corrupt. Range-based download resume is P2.

## 16. Mock (MSW, FE-18) for this protocol

`mocks/upload-handlers.ts` implements all five endpoints plus `HEAD /ping`.

| Aspect | Behaviour |
|---|---|
| State | `Map<uploadId, MockUpload>` with `{ size, chunkSize, partCount, parts: Map<n, { size, sha256 }>, status, clientKey, policyVersion }`. Persisted to IndexedDB (or `sessionStorage`) so that **F5 keeps the "server" state**, which is required for beat 2 on mocks. |
| Create | Idempotent on `Idempotency-Key`. Returns the policy chunk size, clamped like the real server. |
| Part PUT | Verifies the body SHA-256 with `crypto.subtle.digest` against `X-Part-SHA256`. Stores only `{ size, sha256 }`, never the bytes. |
| Latency/bandwidth | `delay = rtt (80 to 300 ms) + bytes / simulatedBps` (configurable, default 6 Mbit/s). |
| Failure injection | Configurable from a dev panel or query flags: `failRate` (default 8 %) returning `503` or `HttpResponse.error()`; `rateLimit429`; `offline` (all requests error); `expire401Once`; `corruptPart` (422); `completeMismatch`; `slowComplete` (202 then polling). |
| Received parts | `GET /uploads/{id}` returns `receivedRanges` computed from the map. |
| Complete | Checks that all parts exist, else 409 `PARTS_MISSING`. File hash cannot be recomputed without bytes, so the mock returns `serverSha256 = clientSha256` with `verdict: match`, or a different value when `completeMismatch` is on. Fault results include `availableAfterMs`. |
| Honest limits | MSW may not emit XHR `upload.onprogress` events. If it does not, `PartTransport` emits synthetic progress in mock mode. The MSW service worker reads each part into the page, so memory flatness is not demonstrable against mocks (bounded by `concurrency x chunkSize`). |

The offline demo on mocks uses the real DevTools Offline toggle, plus an `offline` mock flag as a backup (a service worker still intercepts requests while DevTools Offline is on, so behaviour must be checked). Both paths are in the rehearsal list.

## 17. Server-side contract (for the OpenAPI file)

Base `/api/v1`, same origin, session cookie. All responses carry `X-Trace-Id`. All errors use one shape:

```json
{ "code": "PART_CHECKSUM_MISMATCH", "message": "Suma de control a părții nu coincide.",
  "fieldErrors": [{ "field": "fileSize", "message": "..." }],
  "traceId": "4bf92f35...", "retryAfterMs": 2000, "storage": "S3" }
```

Common to every endpoint: 401 `UNAUTHENTICATED` (no/expired session), 403 `FORBIDDEN` (role may not upload this category at start, or the upload belongs to another real user, BA-65), 429 `RATE_LIMITED` (+ `Retry-After`), 503 `STORAGE_UNAVAILABLE` (names `storage`, + `Retry-After`). Mutating requests carry whichever CSRF header the auth ADR defines (`X-CSRF-Token` or `X-Requested-With`); the engine gets it from an injected header provider.

**Authorisation (BA-65):** checked once on create (real user and the role active then, recorded on the upload). Later requests are accepted when the cookie's **real user** equals the upload's owner. The active role is not re-checked, so a role switch or re-login does not break the upload.

### 17.1 `POST /uploads`

| Item | Value |
|---|---|
| Headers | `Content-Type: application/json`, `Idempotency-Key: <uuid>` (required) |
| Request | `{ "category": "drone" \| "fault" \| "connection", "fileName": string, "fileSize": int, "mimeType": string, "lastModified": int?, "metadata": { ... }, "requestedChunkSize": int? }` |
| 201 | New upload. |
| 200 | Replay of the same key (header `Idempotent-Replayed: true`), same body as 201. |
| Body | `{ "uploadId": string, "status": "open", "chunkSize": int, "partCount": int, "maxParallel": int, "policyVersion": int, "maxFileSize": int, "expiresAt": ISO, "displayName": string, "receivedRanges": [] }` |
| Errors | 413 `FILE_TOO_LARGE`; 422 `TYPE_NOT_ALLOWED`, `VALIDATION_ERROR` (fieldErrors); 409 `IDEMPOTENCY_KEY_REUSED` (same key, different body) |

The server fixes `chunkSize = clamp(requestedChunkSize ?? policy.chunkSize, 5 MiB, min(policy.chunkSize, 32 MiB))` and raises it so `partCount <= 10000`. It records the policy version for this upload.

### 17.2 `PUT /uploads/{uploadId}/parts/{partNumber}` (1-based)

| Item | Value |
|---|---|
| Headers | `Content-Type: application/octet-stream`, `Content-Length` (required, no chunked transfer), `X-Part-SHA256: <64 lowercase hex>` (required) |
| Body | Raw bytes, exactly `chunkSize` except the last part (`fileSize - (partCount-1) * chunkSize`) |
| 200 | `{ "partNumber": int, "size": int, "sha256": string, "alreadyReceived": boolean }` |
| Semantics | Same part + same checksum: 200, `alreadyReceived: true`. Same part + different checksum before complete: replace. The server streams to storage, does not buffer, and only records the part after the hash matches. |
| Errors | 404 `UPLOAD_NOT_FOUND`; 409 `UPLOAD_NOT_OPEN` (completed, aborted, expired, verifying); 413 `PART_TOO_LARGE`; 422 `PART_CHECKSUM_MISMATCH`, `PART_SIZE_MISMATCH`, `PART_NUMBER_OUT_OF_RANGE`; 503 `STORAGE_UNAVAILABLE` |

### 17.3 `GET /uploads/{uploadId}`

200: `{ "uploadId", "status": "open"|"verifying"|"completed"|"failed"|"aborted"|"expired", "fileSize", "chunkSize", "partCount", "receivedRanges": [[1,41],[43,43]], "receivedBytes", "policyVersion", "expiresAt", "result"?: CompleteResult, "error"?: {code, message} }`. `receivedRanges` are inclusive part-number ranges (compact for up to 10,000 parts). Errors: 404 `UPLOAD_NOT_FOUND`.

### 17.4 `POST /uploads/{uploadId}/complete`

| Item | Value |
|---|---|
| Request | `{ "sha256": "<64 hex>", "partCount": int }` |
| 200 | `CompleteResult` (section 13). Mismatch is a **200 with `verdict: "mismatch"`, `status: "failed"`, `fileId: null`**, so the UI can show both hashes. The file is not made available. Repeat calls return the same result. |
| 202 | `{ "status": "verifying" }` + `Retry-After: 2`, when the read-back takes long. The client polls `GET /uploads/{id}` until `result` appears. |
| Errors | 409 `PARTS_MISSING` (`missingRanges: [[a,b]]`); 409 `UPLOAD_NOT_OPEN` (aborted or expired); 422 `PART_COUNT_MISMATCH` |

### 17.5 `DELETE /uploads/{uploadId}`

204. Aborts the multipart upload, deletes staged parts and marks `aborted`. Idempotent (a second call is also 204 or 404). 409 `UPLOAD_COMPLETED` if already completed. Abandoned uploads expire server-side after `expiresAt` (suggest 24 h of inactivity, refreshed by each part), with storage cleanup (S3 `AbortMultipartUpload`, staging purge).

### 17.6 `HEAD /ping`

204, no auth, `Cache-Control: no-store`. Used only as the connectivity probe.

## 18. Test plan

**Unit tests** (Vitest, fake timers, seeded RNG, fake `UploadApi` / `PartTransport` / `UploadRepo`, in-memory `NetMonitor`):

| Area | Cases |
|---|---|
| `backoff.ts` | Delay is in `[0, min(cap, base * 2^n)]` for 1000 seeded draws; cap respected; deterministic with a fixed rng; monotonic ceiling. |
| `machine.ts` | Table-driven: every row of section 11 plus "impossible" events that must be ignored. After restore a record never starts in `uploading`. |
| Scheduler | Concurrency never exceeds the ceiling; AIMD halves on failure and grows after 4 successes; lowest unconfirmed part first; each part confirmed exactly once under random failures (property test, 200 seeds); retries exhaust at 10 and land in resumable `failed`; 429 `Retry-After` honoured. |
| Status handling | One case per row of the status table in section 6 (401 pauses and resumes on `notifySession('valid')`; 409 reconciles; 413, 422 after 3 tries). |
| Net monitor | `offline` aborts in-flight and enters `connection_lost(offline)`; `online` triggers probe; two network errors flip to offline heuristic; first probe success resumes. |
| Resume | Restore from a repo snapshot with half the bitset set: only missing parts are sent; `GET` ranges merge with the local bitset; sampled-part mismatch yields `different_file`. |
| PII | `pii.ts` drops CNP, name and address from a connection document; the persisted record contains no file name for PII categories. |
| Hash worker | hash-wasm result equals Node `crypto` on known vectors and on a 50 MB random file; per-part digests equal expected; abort works. |
| Progress | EMA converges; ETA hidden before 3 s; emit throttle yields at most 4 Hz. |
| Download | Chunked hashing matches; corrupted byte yields `Fișier corupt detectat`; the 64 MiB boundary picks the right mode. |

**E2E (optional, Playwright with CDP offline emulation on the mock):** drop a 200 MB generated file, toggle offline then online, reload, assert resume and no duplicate completed parts.

**Manual rehearsal checklist, beat 2 (real backend, venue-like network, Chrome of the demo machine):**

1. Open Chrome Task Manager (Shift+Esc) and note the tab baseline.
2. Drag the 1 GB+ file into the drop zone (not via `<input>`), fill line and zone. Confirm "se calculează amprenta" runs without frozen frames.
3. On the first Chrome permission prompt later, choose "Allow on every visit" if offered. Record whether it is offered.
4. Mid-upload: DevTools Network, Offline. Confirm "conexiune pierdută" within a few seconds and no console storm.
5. Set Online. Confirm the upload resumes with no click and the percent does not go backwards.
6. Press F5. Confirm the tray is restored, the file reopens (0 or 1 click, note which), and the percent continues from the same value.
7. Confirm the Task Manager memory stays under 300 MB and does not grow with progress.
8. Repeat with throttling "Slow 3G" and with 30 % packet loss if available (hotspot).
9. Let it run 2 minutes after resume, then navigate between screens. The tray keeps running.
10. Switch role (admin to teren to auditor). The upload continues.
11. Expire the session (backend toggle). The upload pauses, login, and it resumes.
12. Finish one 1 GB+ upload on the VPS and confirm hashes match. Check server memory (`kubectl top`) stays flat.
13. Rehearse the fallback: Firefox or a re-select path, to know the exact words.

## Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| UE-1 | Custom chunk API (create, part PUT, status, complete, delete) | tus (`tus-js-client` + `@tus/server`); tus with concatenation | Policy-driven parallelism is first-class; 1:1 with S3 multipart; trivial to mock; no library lock-in; plain NestJS controllers. |
| UE-2 | Hash first (one pass), then parallel upload | Hash while uploading; hash after upload | Final hashes are persisted before the first byte, so reload never re-hashes; per-part checksums are known when parts are sent; simplest resume. |
| UE-3 | hash-wasm for the file hash, WebCrypto `subtle.digest` for per-part checksums, both in one Web Worker | WebCrypto only; hash-wasm for both | WebCrypto cannot hash incrementally; native one-shot digest is cheaper than a second WASM pass. |
| UE-4 | Server verifies each part while streaming, then computes the whole-file SHA-256 by in-order read-back at `complete` | Incremental hash during upload (needs in-order parts); hash of part hashes | Works with out-of-order parallel parts in constant memory; the read-back verifies the stored object (F4). |
| UE-5 | Parts uploaded with XHR; JSON calls with fetch | fetch with duplex streaming; fetch only | XHR gives upload progress, abort and a stall watchdog; fetch upload progress needs HTTP/2 streaming. |
| UE-6 | Chunk size clamped to 5 to 32 MiB, default 8 MiB; parallelism ceiling `clamp(policy, 1, 6)` with AIMD | Fixed size; client-adaptive chunk size | Cloudflare 100 MB limit with 3x headroom (ADR-0005); S3 5 MiB minimum; part numbering must stay fixed for resume; AIMD adapts to a bad link. |
| UE-7 | Policy snapshot captured at start, server echo authoritative, never refreshed | Re-read the policy per part | FE-06: uploads in progress keep their policy. |
| UE-8 | Full-jitter exponential backoff (base 1 s, cap 30 s), max 10 attempts per part, offline does not consume attempts, exhausted retries leave a resumable `failed` | Unlimited retries; fixed delay; no resumable failure | N12 without manual intervention for outages; a dead link still ends visibly. |
| UE-9 | 401 pauses (`paused(auth)`) and auto-resumes after re-login by the same user; 403, 404, 413 fatal; 409 reconciled via `GET`; 422 retried 3x then fatal | Treat 401 as fatal; blind retries on 409 | FE-01 and BA-65 require resume after re-login. |
| UE-10 | Connectivity: `onLine` false is trusted, `true` is not; failed-request heuristic plus `HEAD /ping` probe; abort in-flight on `offline` | `onLine` only | `onLine` is unreliable for "true"; aborting avoids hung requests. |
| UE-11 | Persist upload records in IndexedDB with an allowlist of non-PII metadata; hashes and bitset persisted; bytes never persisted | localStorage; persisting all metadata | Resume needs state, not PII; allowlist enforced centrally in `pii.ts`. |
| UE-12 | Connection documents: no file name stored (only a name hash), no file handle persisted, re-select after reload | Persist handle and name for all categories | Small files finish in seconds; avoids storing an identity-document name or local reference. |
| UE-13 | Reopen the file after reload via a stored `FileSystemFileHandle` (Chromium), with `queryPermission` / one-click `requestPermission`; fallback re-select plus fingerprint and 3-part sampled-hash check | Store the `File` in IndexedDB | Storing the `File` likely copies bytes into IndexedDB (low confidence it is by reference). Handles give 0 to 1 click on Chrome. |
| UE-14 | Hasher-state checkpoints (`save()` / `load()`) not built in v1 | Checkpoint every 64 MiB | Hash-first plus a 3 to 8 s pass makes restart acceptable; P2. |
| UE-15 | Create is idempotent via a client `Idempotency-Key` written before the call; part PUT and complete are idempotent; delete is idempotent | Server-generated keys only | A tab dying mid-create must not leave a duplicate upload. |
| UE-16 | A hash mismatch is a 200 with `verdict: "mismatch"` and `fileId: null`; `complete` may answer 202 and the client polls `GET` | 422 on mismatch; synchronous only | The UI needs both hashes; the read-back of a large file may exceed proxy timeouts. |
| UE-17 | One engine in framework-free TS with injected ports; Zustand adapter as the only React coupling; progress emits throttled to 4 Hz | Logic inside React hooks; per-event store updates | Unit-testable with fake timers; avoids per-byte re-renders. |
| UE-18 | Download verification streams through the worker with backpressure; <= 64 MiB buffered in any browser, larger files saved via `showSaveFilePicker` in Chromium, otherwise server-verified | Always buffer; `tee()` the body; service-worker streaming save | Constant memory where the browser allows it; explicit label of which verification happened. |
| UE-19 | Mock simulates the same protocol with persisted server state, failure injection and bandwidth shaping | Stubbed happy-path mock | Beat 2 (offline, F5) must be rehearsable on mocks (D7). |

## Backend asks

| Ask | Detail | Ref |
|---|---|---|
| Implement the 5 endpoints plus `HEAD /ping` exactly as in section 17, and publish them in OpenAPI | Status codes and error codes are part of the contract. | BA-10..BA-14, BA-00e |
| Chunk limits from the policy; server clamps to 5 MiB to 32 MiB and 10,000 parts | Returns `chunkSize`, `partCount`, `maxParallel`, `policyVersion` on create. | BA-15, BA-10 |
| Part PUT streams to storage and verifies `X-Part-SHA256` while streaming; the route must **not** go through a body parser | Express: no parser on octet-stream; Fastify: custom content-type parser that passes the stream. Required for N3 (server memory flat). | BA-11, N3 |
| S3 targets: native multipart. FTP and Postgres: stage parts on disk, assemble in order at `complete` | Confirm disk space for staging on the 4 GB VPS (at least the largest file times concurrent uploads). | BA-11 |
| Whole-file SHA-256 by in-order read-back at `complete`; a 202 plus poll path for slow cases; encrypt connection documents in the same pass | Confirm typical read-back time for 1 GB. | BA-13 |
| `GET /uploads/{id}` returns `receivedRanges` and, when finished, the result | The resume source of truth. | BA-12 |
| Idempotency: create on `Idempotency-Key`; part replace-or-ignore; complete repeatable | | BA-10, BA-11, BA-13 |
| Authorisation bound at create to the real user and role; later requests check only the real user | A role switch must not break a running upload. | BA-65, BA-04 |
| `X-Trace-Id` on every response (including errors and 202) and `traceId` in every error body | | BA-00a |
| Same-origin `/api` routing; Traefik and Cloudflare must allow `PUT` bodies of 32 MiB and at least 100 s of request time; confirm Traefik `respondingTimeouts` | The default `readTimeout` in the deployed Traefik version is unknown to me; low confidence it is unlimited. | BA-00d, OQ-5 |
| Upload expiry and cleanup (24 h inactivity suggested): abort S3 multipart, purge staging | | BA-14 |
| Download: stored SHA-256 available before or with the bytes (`X-File-SHA256` header or the detail endpoint); `Range` support; `409 FILE_CORRUPT` with both hashes when detectable before streaming | | BA-18 |
| `availableAfterMs` / `availableAt` for faults in `CompleteResult`; `displayName` safe for PII on create | | BA-13, BA-17 |
| CSRF header convention and CORS: none needed (same origin) | Decided in the auth ADR. | OQ-8 |

## Open risks

| Risk | Confidence | Mitigation |
|---|---|---|
| Chrome may not offer or persist "Allow on every visit" for file-handle read permission on the venue Chrome version, so beat 2 needs one click | Medium | One-click `grantFileAccess()` button is built; rehearse on the exact Chrome; narrate it as the identity check. |
| `getAsFileSystemHandle()` on dropped files may return null in some drag sources (for example a network drive or a zipped folder) | Medium | Fall back to re-select; test with a local SSD file for the demo. |
| IndexedDB copying a `File` was assessed only by reasoning (not tested); the design avoids it | Low on details | No reliance; handle-based design does not store the `File`. |
| hash-wasm throughput (3 to 8 s per GB) is an estimate | Medium | Benchmark on the demo laptop at milestone 5; if slow, show the progress bar and narrate it. |
| MSW's XHR interception may not emit `upload.onprogress`, and reads each part into page memory | Medium | Synthetic progress in mock mode; memory-flat proof only against the real backend. |
| Traefik default timeouts or a body limit could cut 8 MiB parts at about 2 Mbit/s uplink | Low to medium | Smaller chunks (5 MiB) for drone if needed; backend confirms `readTimeout`. |
| `complete` read-back of 1 GB+ may exceed the Cloudflare 100 s window on a slow disk | Medium | 202 plus polling is in the contract; backend measures. |
| Hidden-tab timer throttling can stretch retry delays | High that it happens, low impact | Keep the demo tab in the foreground; XHR itself is not throttled. |
| The CSP must allow `'wasm-unsafe-eval'` and worker scripts for hash-wasm | High | Passed to the CSP/threat-model doc. |
| Storing the connection-document name only as a hash leaves the tray with no meaningful label before create returns | Low | Tray shows "Document racordare nr. {requestNumber}" until the server's safe name arrives. |
| Staged parts for FTP and Postgres targets need disk on the VPS | Medium | Backend confirms staging path and size; policy `maxFileSize` for those categories. |