# FileGrid PPC: backend API (P2)

This is the REST contract the NestJS backend (`backend/`) implements. It follows the frontend proposal,
[`docs/api/openapi.frontend-proposal.yaml`](api/openapi.frontend-proposal.yaml), except where
[Differences from the frontend proposal](#differences-from-the-frontend-proposal) says otherwise. It also
follows P1's contracts in the README ("Contracte pentru P2/P3").

## Basics

- **Base path:** `/api/v1` on the same host as the UI. The probes and the Prometheus endpoint (`/healthz`,
  `/readyz`, `/metrics`) sit at the root. The container listens on port **8000** and runs as uid 10001.
- **Format:** JSON in **camelCase**, timestamps in ISO 8601 UTC, opaque IDs (UUIDs).
- **Category and storage ids:** these are the team identifiers, shared by policies, metrics, dashboards and
  the UI.
  - Categories: `meter_readings`, `fault_records`, `connection_documents`, `drone_videos`.
  - Storages: `s3`, `ftp`, `db`.
  - Zones: `muntenia`, `banat`, `dobrogea`.
- **Client IP:** the login rate limiter and the audit trail use the client's IP. Behind Traefik that is
  the address in `X-Forwarded-For`, which the backend believes only when the TCP peer is in
  `TRUSTED_PROXY_CIDRS` (default `10.42.0.0/16,10.43.0.0/16`, the k3s pod and service CIDRs; Traefik keeps
  the client source IP with `externalTrafficPolicy: Local`). From any other peer the header is ignored and
  the peer address is used, so a client cannot choose its own IP.
- **Response headers:** every answer carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (sessions, user data and file metadata are
  never cached). File content sends `private, no-store` with its `ETag`, `Accept-Ranges` and `If-Range`
  handling, and `GET /stream` sends `no-cache, no-transform`. HSTS is added by Traefik.
- **Trace ID:** every response carries `X-Trace-Id`. A valid incoming value (`[A-Za-z0-9-]{1,64}`) is
  reused; otherwise the backend generates one. `GET /traces/{traceId}` shows the steps of that operation.
- **Errors:** one body for every error: `{ code, message, traceId, fieldErrors?, ...extras }`.
  - `code` is a stable UPPER_SNAKE identifier.
  - `message` is Romanian and safe to show to the user.
  - The extras depend on the error: `retryAfterMs`, `storage`, `missingRanges`, `expectedSha256`,
    `actualSha256` or `currentPolicy`.
  - 5xx responses never include internal details.
  - A 503 always comes with `Retry-After`.
- **Lists:** paged lists return `{ data, meta: { page, pageSize, total, hasMore } }` and take the `page`
  and `pageSize` parameters (at most 200 per page), newest first. Short fixed lists return `{ data }`.

## Auth and session

| Method & path | Who | Notes |
|---|---|---|
| `GET /auth/login-options` | anyone | `{passwordless: boolean}`: whether the login form asks for a password. `Cache-Control: public, max-age=5` |
| `POST /auth/login` `{username, password}` | anyone | `200 Me` and sets the cookie. `password` may be left out while passwordless login is on. Errors: `401 INVALID_CREDENTIALS`, `422 VALIDATION_ERROR` (no `password` while passwordless login is off), `429 RATE_LIMITED` (10 failures per 5 min per client IP and username) |
| `POST /auth/logout` | session | `204`, expires the cookie |
| `GET /auth/me` | session | `Me` |
| `POST /auth/refresh` | session | `200 Me`, with a new idle window |
| `POST /demo/acting-role` `{role, minutes?}` / `DELETE /demo/acting-role` | real admin, demo mode | Demo role switcher. Audited as `role_switch` |

- **Cookie:** `__Host-fg_session` with `Secure; HttpOnly; SameSite=Strict; Path=/` and an 8 h absolute
  expiry. The 30 min idle expiry slides on use: an authenticated response may re-issue the cookie.
- **Local runs:** with `COOKIE_SECURE=false` (plain HTTP) the cookie is called `fg_session`.
- **Scripts:** the same token is also accepted as `Authorization: Bearer <token>`.
- **CSRF:** a non-GET request authenticated by the cookie must send `X-Requested-With: filegrid`, and
  must not carry a foreign `Origin` or `Sec-Fetch-Site: cross-site`. Otherwise the answer is
  `403 CSRF_REJECTED`. Requests with a bearer token or `X-API-Key` are exempt. No CORS is served.
- **`Me` shape:** `{ user, realUser, activeRole, roles, capabilities, demoMode, actingRoleExpiresAt,
  expiresAt, idleExpiresAt, serverTime }`.
  - `user` is the acting persona and `realUser` is the account.
  - `roles` lists the roles the account can act as: all five for an admin in demo mode, otherwise only its
    own.
- **Demo accounts:** in demo mode one account exists per role for the login page's role dropdown
  (ADR-0022). The username is the role id (`teren`, `dispecerat`, `racordari`, `auditor`). The password is
  `DEMO_USERS_PASSWORD`, or `ADMIN_PASSWORD` when that is unset. With demo mode off these accounts are
  removed.
- **Passwordless login (temporary, for the demo):** with `FILEGRID_PASSWORDLESS_LOGIN=true` and demo mode on,
  `POST /auth/login` accepts `{username}` alone and logs in that existing account (a role id, or the admin by
  `ADMIN_USERNAME`) without checking the password; a password that is sent is ignored. An unknown username
  still gets `401 INVALID_CREDENTIALS`. The rate limit, cookie, CSRF, expiries and capabilities do not change;
  the audit rows are marked `demo: true`, `details: "passwordless"`. With demo mode off the flag is ignored
  and the backend logs a warning at start. Set it to `false` to require passwords again (no code change).
- **Roles:** `teren`, `dispecerat`, `racordari`, `auditor`, `admin`. The capability matrix is enforced in
  `backend/src/common/domain.ts` and mirrored in `frontend/src/lib/auth/capabilities.ts`.
- **Visibility:** a file the active role may not see answers 404.
- **Uploads and role switches:** an upload is bound to the real user, so switching role never breaks one.

## Policies (policy engine)

| Method & path | Who | Notes |
|---|---|---|
| `GET /policies` | session | `{ data: Policy[] }` |
| `GET /policies/{category}` | session | `Policy` |
| `PUT /policies/{category}` | `edit_policies` | Body `PolicyUpdateRequest`. Answers `200 Policy` (version + 1), `409 POLICY_VERSION_CONFLICT` with `currentPolicy`, `422 ENCRYPTION_LOCKED` or `422 VALIDATION_ERROR` |
| `GET /policies/{category}/versions` | session | `{ data: [{ version, policy, changedAt, changedBy, changes: [{field, from, to}] }] }` |

- **Policy fields:** `category`, `version`, `primaryStorage`, `fallbackStorage`, `encryptionAtRest`,
  `encryptionLocked` (true for `connection_documents`), `encryptionAlgorithm`, `chunkSize`, `maxParallel`,
  `maxConcurrency`, `maxFileSize`, `allowedTypes`, `retentionDays`, `updatedAt` and `updatedBy`.
- **Limits:** `chunkSize` must be between 1 and 32 MiB and `maxParallel` between 1 and 6. `fallbackStorage`
  must differ from the primary.
- **`maxConcurrency` (1-256):** the server-side bulkhead, an extra field compared with the proposal. It is
  optional in a PUT; when left out, the current value is kept.
- **Live changes:** every operation reads the policy live, so a PUT changes where new files go immediately,
  on every replica. Uploads that have already started keep their snapshot.

Seed policies:

| Category | Primary | Fallback | Encrypted | Part size | Max size |
|---|---|---|---|---|---|
| `meter_readings` | db | s3 | no | 1 MiB | 16 MiB |
| `fault_records` | s3 | db | no | 5 MiB | 512 MiB |
| `connection_documents` | s3 | db | **yes** | 5 MiB | 50 MiB |
| `drone_videos` | ftp | s3 | no | 16 MiB | 4 GiB |

## Resumable upload

1. **`POST /uploads`** with the required `Idempotency-Key` header (8-64 characters, a UUID is
   recommended). The body is `{ category, fileName, fileSize, mimeType, metadata }`, where `metadata`
   depends on `kind`:
   - `fault`: `{ zone, substation, eventTime, severity }`
   - `connection`: `{ requestNumber, documentType, applicantName, cnp, zone? }`
   - `drone`: `{ lineSection, zone, inspectionDate }`

   It answers `201 UploadSession`: `{ uploadId, status: "open", chunkSize, partCount, maxParallel,
   policyVersion, maxFileSize, expiresAt, displayName, receivedRanges }`. The same key and file give
   `200` with the same session; a different file under the same key gives `409 IDEMPOTENCY_KEY_REUSED`.
   Other errors: `403` when the role cannot upload this category, `413 FILE_TOO_LARGE`,
   `422 TYPE_NOT_ALLOWED`.
2. **`PUT /uploads/{id}/parts/{n}`**, with `n` starting at 1. The raw `application/octet-stream` body is
   streamed to storage and never parsed. It takes an optional `X-Part-SHA256` header.
   - Size: every part is `chunkSize`, except the last one.
   - Answer: `200 { partNumber, size, sha256, alreadyReceived, traceId }`. Sending a part again with the
     same hash is free and returns `alreadyReceived: true`. Every part is an operation of its own
     (`upload.part`, also when it is refused): `traceId` (the same as `X-Trace-Id`) opens its trace.
   - Errors: `422 PART_CHECKSUM_MISMATCH`, `PART_SIZE_MISMATCH`, `PART_NUMBER_OUT_OF_RANGE`,
     `413 PART_TOO_LARGE`, `409 UPLOAD_NOT_OPEN` or `UPLOAD_COMPLETED`, and
     `503 STORAGE_UNAVAILABLE` or `CATEGORY_BUSY` (retry after `Retry-After`).
3. **`GET /uploads/{id}`** returns `{ uploadId, status, fileSize, chunkSize, partCount, receivedRanges,
   receivedBytes, policyVersion, expiresAt, startedAsRole, result, error }`, used for resuming.
   `receivedRanges` uses inclusive ranges, e.g. `[[1,41],[43,43]]`.
4. **`POST /uploads/{id}/complete`** with `{ sha256, partCount }`, where `sha256` is the hex hash of the
   whole file. It answers `200 CompleteResult`:
   `{ status, verdict: "match"|"mismatch", fileId, clientSha256, serverSha256, size, storage,
   usedFallback, policyVersion, encryptedAtRest, availableAt, availableAfterMs, traceId }`.
   - **Slow completion:** if it takes more than about 8 s, the answer is `202 { status: "verifying" }`
     with `Retry-After: 2`. Poll `GET /uploads/{id}` until `result` is set.
   - **Errors:** `409 PARTS_MISSING` (with `missingRanges`), `422 PART_COUNT_MISMATCH`,
     `503 STORAGE_UNAVAILABLE`.
   - **Hash mismatch:** the answer is `verdict: "mismatch"` with `fileId: null`, and no file is kept.
5. **`DELETE /uploads/{id}`** returns `204` and drops the staged parts.
6. **Abandoned uploads:** a session expires `UPLOAD_SESSION_TTL_HOURS` (24) after its last part. Every
   `UPLOAD_SWEEP_INTERVAL_S` (300) each replica marks expired sessions `expired` and drops their staged parts
   (and those of aborted sessions); a part whose storage is down is kept for the next sweep. A part sent
   again with the same `X-Part-SHA256` is answered `alreadyReceived` only after its body has been read, so a
   retrying client over HTTP/2 is not cut off mid-body.
6. **`GET` or `HEAD /ping`** returns `204`, as a connectivity probe for the resume logic.

How the server handles an upload:
- **Statelessness:** the session and the part list live in Postgres. Part bytes are staged in the policy's
  storage under `staging/{uploadId}/{n}`, encrypted for encrypted categories. Any replica can take any
  request.
- **Completion:** `complete` reads the parts back in order and checks each part's hash. It then writes the
  file to the primary storage, or to the fallback when the primary is down. Encryption is FGE1
  (AES-256-GCM). The file is confirmed only after a durable write **and** a matching whole-file SHA-256.
- **Session expiry:** a session expires after 24 h without parts.

## Files

| Method & path | Who | Notes |
|---|---|---|
| `GET /files?category=&q=&from=&to=&zone=&origin=&integrity=&excludeGenerated=&sort=&page=&pageSize=` | session | `{ data: FileSummary[], meta }`, limited to the categories the active role may see |
| `GET /files/{id}` | view capability | `FileDetail`: `FileSummary` plus `clientSha256`, `serverSha256`, `policyName`, `encryptionAlgorithm`, `availableAt`, `uploadTraceId`, `lastVerifiedAt`, `metadata` |
| `GET /files/{id}/content` | view capability | The file, with the SHA-256 recomputed while reading (see below) |
| `POST /files/{id}/verification` | view capability | `{ fileId, state: "server_verified"|"corrupt", expectedSha256, actualSha256, storage, verifiedAt, traceId }` |
| `GET /files/{id}/custody` | view capability | `{ data: CustodyEvent[] }`, built from the audit trail |
| `POST /files/{id}/reveal` `{reason}` | `reveal_pii` (auditor) | `{ fileId, applicantName, cnp, address, expiresAt, auditEventId }`, audited with the reason |

- **`FileSummary`:** `{ id, displayName, category, size, mimeType, createdAt, uploadedBy, zone, origin,
  storage, usedFallback, integrity, encryptedAtRest, policyVersion }`.
  - `integrity` is one of `verified`, `server_verified`, `unverified` or `corrupt`.
  - `origin` is one of `manual`, `simulator`, `storm` or `seed`.
- **Download headers:** `Content-Disposition: attachment` with a sanitised `filename*`, `nosniff`,
  `X-File-SHA256` and an `ETag` taken from the hash.
- **Integrity on download:** files up to 8 MiB are verified completely before the first byte is sent, so
  corruption answers `409 FILE_CORRUPT` with both hashes and `fallbackAvailable: false` (each file is stored
  once, on the primary or on the fallback, so there is no second copy to restore from). Larger files are streamed, and the connection is
  cut (never ended cleanly) if the hash turns out wrong. In both cases the file is marked `corrupt`.
- **Byte ranges (`Range: bytes=a-b`, `bytes=a-`, `bytes=-n`):** a single range of a plain file answers
  `206` with `Content-Range: bytes a-b/size` and only those bytes (`Accept-Ranges: bytes`). `416
  RANGE_NOT_SATISFIABLE` with `Content-Range: bytes */size` when it is malformed or starts past the end. Several ranges, or an `If-Range` that no
  longer matches the `ETag`, get the whole file (`200`). Encrypted files (`Accept-Ranges: none`) ignore
  `Range`: they are decrypted and verified whole. Only a range from byte 0 is a custody event (`download`).
- **What never leaves the backend:** storage URLs, keys and FTP paths.
- **Personal data:** for connection documents the name and CNP are stored sealed with the KEK. Only the
  masked values appear in `metadata`: `applicantNameMasked` ("I*** P***") and `cnpMasked`
  ("1*********456"). `displayName` is `Document racordare {requestNumber} ({documentType})`.

## Meter readings

`POST /meter-readings` is the simulator's entry point and needs `X-API-Key: <METER_API_KEY>` instead of a
session.
- **Body:** `{ readings: [{ readingId, meterId, zone, readingTime, kwh, sequence, origin }] }`, with 1 to 500
  readings per batch. `origin` is `simulator`, `storm` or `seed`.
- **Answer:** `200 { received, stored, duplicates, traceId }`.
- **Idempotency:** idempotent on `readingId`. A retried or duplicated reading is acknowledged and counted as
  a duplicate, never stored twice (the primary key guarantees it even when replicas race).
- **Policy:** each batch of new readings is also stored as one JSONL object in the policy's storage, `db`
  with `s3` as fallback.
- **Errors:** `401 INVALID_API_KEY`, `422` for an invalid batch (don't retry it), `503` with `Retry-After`
  (retry with the same readingIds).

| Method & path | Who | Notes |
|---|---|---|
| `GET /meter-readings?zone=&meterId=&origin=&page=&pageSize=` | `view_meters` | `MeterReading[]`: `{ fileId, meterId, zone, readingTime, kwh, sequence, receivedAt, storage, origin }` |
| `GET /meters/counters` | `view_meters` | `{ received, unique, duplicatesRejected, lost, ratePerS, byZone, at }`. `lost` = sent − acked − queued as reported by the simulator, or `null` when the simulator is not reachable |
| `GET /meters/simulator` | `view_meters` | `{ mode, ratePerS, normalRatePerS, peakRatePerS, queueDepth, stormEndsAt, sentUnique, ackedUnique }` |
| `PUT /meters/simulator` `{mode, ratePerS?, durationS?}` | demo | `mode` is one of `normal`, `peak`, `custom` or `stopped` |

## Statistics (each answer carries an `interpretation: { text, recommendation, facts }` in Romanian)

| Method & path | Notes |
|---|---|
| `GET /statistics/periods` | `{ data: Period[] }`, newest first. A period is a run of storm batches (`peak`) or of regular simulator batches (`normal`) over the last 7 days: `{ id, label, kind, origin, start, end }`. `id` is the start in epoch milliseconds, so it stays the same while a running period grows; a running storm has `end: null` |
| `GET /statistics/storage-fit` | `{ items: [{ category, storages: [{ storage, samples, p50Ms, p95Ms, throughputBps, errorRate }], recommendedStorage, interpretation }] }`, measured from the operations log over 7 days |
| `GET /statistics/period-comparison?a=&b=` | `{ periodA, periodB, rows: [{ category, metric, a, b, deltaPct }], interpretation }`, where `metric` is one of `p95Ms`, `opsPerS`, `errorRate` or `volume`. `a` and `b` are period ids; either may be the newest, still-running period (measured up to now). An older `start-end` id is still accepted. `404 NOT_FOUND` for an unknown period |
| `GET /statistics/grid-insights` | `{ faultsByZone, consumptionByHourZone, anomalies, interpretation }` over the last 24 h. Anomalies are readings of zero or above 5x the zone average |

All of these need `view_statistics`.

## Monitoring and traces

| Method & path | Who | Notes |
|---|---|---|
| `GET /storage-health` | session | `{ data: [{ storage, status: ok|degraded|down, latencyMs, lastCheckAt, circuitState }] }`, from the health monitor (every 5 s) |
| `GET /metrics/bulkhead?window=5m\|15m\|1h` | `view_observability` | `{ window, stepS, series: [{ category, points: [{ t, p95Ms, opsPerS }] }], data: [{ category, active, queued }] }`. `series` is the bulkhead proof chart: 30 points per category on one time axis (a point every 10, 30 or 120 s; default `15m`), p95 latency and operations per second of every traced operation of the category, all replicas (from the operations log). `p95Ms` is `null` and `opsPerS` 0 for a point without traffic. `data` is the live state of this replica's compartments |
| `GET /metrics/matrix?window=5m\|1h\|24h` | `view_observability` | `{ window, generatedAt, cells: [{ category, storage, requests, noTraffic, p50Ms, p95Ms, p99Ms, throughputBps, opsPerS, errorRate }] }`: the 12 category x storage cells (default `5m`) from the operations log. A cell without traffic has `noTraffic: true`, `requests: 0` and `null` for every measure |
| `GET /traces/{traceId}` | view capability of the operation's category | `{ traceId, operation, category, fileId, storage, startedAt, durationMs, status, spans: [{ spanId, parentSpanId, name, startOffsetMs, durationMs, status, storage, errorCode, attributes }] }`. A role that may not see the category gets the same `404 NOT_FOUND` as for an unknown id (like `GET /files/{id}`). See "Trace spans" below |
| `GET /healthz`, `GET /readyz` | probes | `/healthz` is 200 while the process lives. `/readyz` answers `{ status, database }`: **200** `ready`, or `degraded` when a storage or the DB is down after the start, as the README requires. It answers **503** (with `Retry-After`) only while `starting` (the database has not been reached, migrated and seeded yet) and while `stopping` (SIGTERM, see below) |
| `GET /metrics` | Prometheus | Text exposition |

### Trace spans

`operation` is `upload.part`, `upload.complete`, `file.download`, `file.verify` or `meter.batch`. The first
span is always `api` (spanId `1`, `startOffsetMs` 0, the whole request; its `attributes` hold `method`,
`path` without the query string, and `uploadId`/`partNumber` for uploads). Every other span is its child
(`parentSpanId: "1"`), in the order the steps finished:

| Span | When | `attributes` |
|---|---|---|
| `policy` | upload create and complete | |
| `encryption` | the policy encrypts at rest (`connection_documents`) | `algorithm` (`AES-256-GCM`), `keyId`, `sizeBytes`. It is interleaved with `storage.put` (chunk by chunk), so it starts with it and its `durationMs` is the time spent in the cipher |
| `storage.put`, `storage.get` | every write or read | `storage`, `category`, `encrypted`, `sizeBytes` |
| `hash.verify` | `POST /files/{id}/verification` | `storage`, `category` |
| `audit` | the audit record of the operation (upload, download, verify) | `action`, `outcome` |
| `confirm` | the DB transaction that makes an upload visible (it contains `audit`) | |

The trace of a connection document's upload thus reads `api → policy → encryption → storage.put → audit →
confirm`, each with its duration. Only these allow-listed attributes are stored: no metadata, no personal
data, no query strings. A download is recorded once its bytes are sent, so its trace can appear a few
milliseconds after the response ends.

## Audit, guarantees, alerts and the live stream

| Method & path | Who | Notes |
|---|---|---|
| `GET /audit-events?action=&actor=&fileId=&from=&to=&page=&pageSize=` | `view_audit` | `{ data: AuditEvent[], meta }`, newest first. `AuditEvent`: `{ id, at, actor: { id, username, displayName, role }, actingAs, demo, action, outcome, category, fileId, fileDisplayName, reason, details, traceId, clientIp }`. `clientIp` is the client of the audited request (see Basics), `null` for background work and for rows written before it was recorded |
| `GET /guarantees` | session | `{ data: [{ category, state: ok\|at_risk\|violated, causeCode, causeFacts, metrics: [{ key, value, unit, threshold, comparator }], updatedAt }] }`, the four business guarantees with the `GUARANTEE_*` thresholds |
| `GET /alerts?state=active\|resolved\|all&page=&pageSize=` | session | `{ data: [{ id, category, state, raisedAt, resolvedAt, causeCode, causeFacts, traceId, acknowledgedAt, acknowledgedBy }], meta }`. The leader replica evaluates the guarantees every `GUARANTEE_EVAL_INTERVAL_S` and records the transitions |
| `POST /alerts/{id}/acknowledge` | session | The alert, acknowledged (idempotent, audited as `alert_ack`) |
| `GET /stream` | session | Server-Sent Events, see below. `503 STREAM_BUSY` (with `Retry-After`) when `STREAM_MAX_CLIENTS` streams are open on the replica |

### The live stream (`GET /stream`)

`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. The first
line is `retry: 3000`. Every event has a monotonic `id:` and a named `event:`; `data:` is one JSON object.
There is no replay (`Last-Event-ID` is ignored): events are snapshots or hints, and a client refetches over
REST after it (re)connects. A stream ends when its session does and when the replica shuts down; `EventSource`
reconnects by itself. Each event goes only to the streams whose active role may see it:

| Event | Who gets it | `data` |
|---|---|---|
| `ping` | every stream, every `STREAM_PING_S` (20 s) | `{ serverTime }` |
| `meters.counters` | `view_meters`, every `STREAM_COUNTERS_INTERVAL_S` (2 s) | `MeterCounters`, as `GET /meters/counters` |
| `guarantees.status` | every stream, after each evaluation | `{ items }`: the `data` of `GET /guarantees` |
| `alert.raised`, `alert.updated` | every stream | one alert, as in `GET /alerts` |
| `storage.health` | every stream, when a storage changes state | `{ items }`: the `data` of `GET /storage-health` |
| `file.created` | roles that see the category | `{ fileId, category, zone, severity, substation, origin, createdAt, availableAt }` |
| `file.integrity` | roles that see the category | `{ fileId, category, state: verified\|server_verified\|corrupt, traceId }` |
| `upload.verified` | the uploader only | `{ uploadId, fileId, verdict: match\|mismatch, serverSha256, availableAfterMs }` |
| `policy.updated` | every stream | `{ category, version }` |
| `simulator.status` | `view_meters` | the simulator status, as `GET /meters/simulator` |
| `demo.storm` | every stream | `{ category: "meter_readings", factor, state: started\|stopped, endsAt }` |

The schemas of every payload are in `GET /docs-json` (`x-sse-events` of `/stream`), checked against real
events by `backend/test/docs.e2e-spec.ts`.

**Background requests do not keep a session alive.** `GET /stream`, `GET /auth/me` and the GETs a screen polls
(`/storage-health`, `/meters/counters`, `/guarantees`, `/alerts`, `/metrics/bulkhead`, `/metrics/matrix`)
never re-issue the cookie, so an open tab does not extend the 30 min idle window. Only `POST /auth/refresh`
and real activity do.

## Demo controls (demo mode only: 404 when `FILEGRID_DEMO_MODE=false`; admin, audited)

| Method & path | Notes |
|---|---|
| `GET /demo/status` | `{ demoMode, simulator, storm, storages }` |
| `POST /demo/storms` `{category: "meter_readings", durationS: 10..3600}` | Starts simulator peak mode (rate x `STORM_FACTOR`). `409 STORM_ALREADY_RUNNING` when one is running |
| `DELETE /demo/storms/meter_readings` | Back to the normal rate |
| `POST /demo/corruptions` `{fileId}` | Flips one byte of the stored object in place. The next download or verification detects it |
| `POST /demo/storages/{s3|ftp}/{stop|start}` | Scales the StatefulSet to 0 or 1 through the Kubernetes API, with the RBAC in `deploy/k8s/demo-rbac.yaml`. `db` is refused because it also holds the metadata |

The network-slowdown control (`tc netem`) stays a `make` target run by P1, because it needs root on the
node.

## Start and shutdown

- **Start:** the server listens at once (`/healthz` 200, `/readyz` 503 `starting`). It then reaches the
  database, retrying DNS and connection errors with backoff (0.5 s doubling up to 5 s) for
  `FILEGRID_DB_BOOT_TIMEOUT_S` (90 s), runs the migrations (a Postgres advisory lock lets replicas take
  turns) and creates the accounts from the environment. Then `/readyz` turns 200. If the database stays
  unreachable, the process logs `database not reachable at startup; giving up` and exits 1, and
  Kubernetes restarts it.
- **Shutdown (SIGTERM, SIGINT):** `/readyz` turns 503 `stopping` and the live streams (`GET /stream`) end,
  so `EventSource` reconnects to another replica. The server stops accepting connections, and responses
  still being written carry `Connection: close`. In-flight requests finish, for at most
  `FILEGRID_SHUTDOWN_DRAIN_S` (20 s, below the pod's grace period), and anything still open after that is
  cut. Only then do the database pool, the storages and the timers close, so a rolling update or an HPA
  scale-down answers no request with 500.

## Metrics (confirmation for P1: the names match the README)

Every outcome of the counters below (failures included) is exported at 0 from the start, per category,
zone or storage, so `rate()` and `increase()` see the first failure.

- **Uploads:** `filegrid_uploads_total{category,outcome}` and
  `filegrid_upload_duration_seconds{category,outcome}`. The outcome is one of `success`, `mismatch` or
  `error`. The duration runs from complete to durable.
- **Meter readings:**
  - `filegrid_meter_readings_stored_total{zone}` counts first stores only.
  - `filegrid_meter_readings_duplicates_total{zone}` counts deduplicated retries.
  - `filegrid_meter_readings_duplicate_stored_total` is always 0.
  - `filegrid_meter_batches_total{outcome}` (`success`, `rejected` or `error`).
  - `filegrid_meter_readings_lost` (gauge, no labels): the readings lost, with the same definition as the
    `lost` metric of `GET /guarantees` (sent − acked − queued, as the simulator reports it). The guarantee
    evaluator sets it on the leader replica every `GUARANTEE_EVAL_INTERVAL_S`; the other replicas show 0. It
    is 0 when nothing is lost and `NaN` while the loss is unknown (simulator unreachable). The
    `MeterReadingsLost` alert (`> 0` for 2 m) and the dashboard's "Pierdute" stat use only this gauge.
- **Storages:** the P1 metrics unchanged: `filegrid_storage_operation_seconds`,
  `filegrid_storage_bytes_total`, `filegrid_storage_errors_total`, `filegrid_storage_up` and
  `filegrid_storage_circuit_state`.
- **Downloads and integrity:** `filegrid_downloads_total{category,outcome}` (outcome `success`, `corrupt`,
  `aborted` or `error`),
  `filegrid_integrity_failures_total{category,storage}`.
- **Bulkhead:** `filegrid_bulkhead_in_flight{category}`, `filegrid_bulkhead_queued{category}` and
  `filegrid_bulkhead_rejected_total{category}`.
- **Process:** `filegrid_backend_*` (CPU, heap, event loop lag).
- **Simulator:** `filegrid_sim_readings_sent_total{zone}` counts **unique** readings, as the
  `MeterReadingsLost` alert expects. Also `filegrid_sim_readings_acked_total{zone}`,
  `filegrid_sim_retries_total`, `filegrid_sim_duplicates_sent_total`,
  `filegrid_sim_readings_rejected_total`, `filegrid_sim_requests_total{status}`,
  `filegrid_sim_rate_per_second`, `filegrid_sim_queue_depth` and `filegrid_sim_mode{mode}`.

## Differences from the frontend proposal

- **Identifiers:** category and storage ids are the team identifiers from the README (`fault_records`,
  `s3`, ...), not `fault` or `S3`. The UI shows the labels (S3, FTP, PostgreSQL). The metadata `kind`
  values stay `fault`, `connection` and `drone`.
- **Machine-readable contract:** `GET /api/v1/docs-json` (no session) serves the OpenAPI 3 document of the
  real API (`backend/src/docs/openapi.json`). It started from the proposal and was corrected to the backend:
  `backend/test/docs.e2e-spec.ts` fails when a Nest route is missing from it (or it lists one Nest does not
  have), when a real answer or live event does not match its schema, or when a `$ref` dangles. The frontend
  generates its types from it: `API_SPEC=https://<host>/api/v1/docs-json npm run gen:api` in `frontend/`.
- **What the document changes compared with the proposal:** the category and storage ids above; `UserRef.role`
  and a few measures are nullable; `DemoStatus` is `{ demoMode, simulator, storm, storages }`; storms answer
  the simulator status (`201` on start); a storage is stopped with `POST /demo/storages/{storage}/{stop|start}`
  (no body); `POST /demo/corruptions` answers `201 { fileId, storage, corruptedAt }`; `GET
  /statistics/period-comparison` takes `a` and `b`; `POST /meter-readings` (simulator, `X-API-Key`) is
  documented. Proposal parameters the backend does not implement were removed: `storage` and `uploaderId` on
  `GET /files`; `from`, `to` and `excludeGenerated` on `GET /meter-readings`; `periodId` and
  `excludeGenerated` on `GET /statistics/storage-fit` and `/grid-insights`; `lastEventId` on `GET /stream`.
- **Extra endpoints:** `maxConcurrency` on policies and `POST /demo/storages/{storage}/{action}`.

## Answers to `docs/api/HANDOFF-backend.md`

1. **Routing:** `/api/v1` behind the existing Ingress (`/api`, no prefix stripping). The Service is
   `filegrid-backend:8000` (P1's manifests).
2. **Session:** cookie and CSRF exactly as described above, with the `me` shape from the proposal.
3. **Upload:** the custom chunk API with `202` and polling. Parts are staged in the policy's storage, not
   on the pod's disk.
4. **Errors and traces:** the error shape and `X-Trace-Id` are on every response. Traces come from the
   operations log.
5. **SSE:** `GET /stream`, cross-replica through Postgres LISTEN/NOTIFY (see [Audit, guarantees, alerts and the live stream](#audit-guarantees-alerts-and-the-live-stream)).
6. **Storage outage:** writes go to the policy fallback. If the fallback is down too, the answer is
   `503 STORAGE_UNAVAILABLE` with `storage` and `Retry-After`.
7. **Corruption:** any storage can be corrupted in place (S3 object, FTP file, DB row).
8. **Simulator:** P2 builds it (`simulator/`). Its rate is controlled by `PUT /meters/simulator`.
9. **Thresholds:** not configurable yet.
10. **Statistics text:** the backend sends Romanian `text` and `recommendation` plus `facts`.
11. **Map granularity:** 3 regions (`county` is always null).
12. **Seed history:** periods come from simulator batches. Start a storm before the demo to get a peak
    period.

## Backend environment

The variables come from the k3s Secrets `filegrid-storage-credentials` and `filegrid-app-secrets` plus
`deploy/k8s/app/backend/deployment.yaml`. Every name is listed in `backend/.env.example`:

- **Database:** `POSTGRES_*` and `FILEGRID_PG_HOST`/`FILEGRID_PG_PORT` (or `FILEGRID_PG_DSN`).
- **S3:** `S3_*` and `FILEGRID_S3_*`.
- **FTP:** `FTP_*` and `FILEGRID_FTP_*`.
- **Secrets:** `JWT_SECRET`, `METER_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `FILEGRID_KEK` and
  `FILEGRID_KEK_ID`.

Optional:
- `FILEGRID_DB_BOOT_TIMEOUT_S` (default 90) and `FILEGRID_SHUTDOWN_DRAIN_S` (default 20), see
  [Start and shutdown](#start-and-shutdown)
- `TRUSTED_PROXY_CIDRS` (default `10.42.0.0/16,10.43.0.0/16`; empty = trust no proxy), see Basics
- `FILEGRID_DEMO_MODE` (default `true`)
- `FILEGRID_PASSWORDLESS_LOGIN` (default `false`; only takes effect with demo mode on, see "Auth and session")
- `DEMO_USERS_PASSWORD` (default: `ADMIN_PASSWORD`)
- `SIMULATOR_URL` (default `http://filegrid-simulator.filegrid.svc:8080`)
- `SESSION_TTL_MINUTES` (480) and `SESSION_IDLE_MINUTES` (30)
- `UPLOAD_SESSION_TTL_HOURS` (24) and `UPLOAD_SWEEP_INTERVAL_S` (300), see "Resumable upload"
- `COOKIE_SECURE` (default `true`)
- `FILEGRID_STORAGE_DRIVER=memory` (no S3/FTP; for local runs)
- `LOG_LEVEL`

Simulator variables: `BACKEND_URL`, `METER_API_KEY`, `METER_RATE` (default 10/s), `STORM_FACTOR` (10),
`PORT` (8080), `METER_COUNT`, `BATCH_MAX`, `DUPLICATE_RATIO` (0.02) and `MAX_RATE`. The simulator logs JSON
lines with the trace id of each batch request in `trace_id`, the same field as the backend's logs (it sends
the same id as `X-Trace-Id`).
