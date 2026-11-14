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
| `POST /auth/login` `{username, password}` | anyone | `200 Me` and sets the cookie. Errors: `401 INVALID_CREDENTIALS`, `429 RATE_LIMITED` (10 failures per 5 min per IP and username) |
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
- **Roles:** `teren`, `dispecerat`, `racordari`, `auditor`, `admin`. The capability matrix is the one in
  `docs/frontend/prd.md` FE-01, enforced in `backend/src/common/domain.ts`.
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
   - Answer: `200 { partNumber, size, sha256, alreadyReceived }`. Sending a part again with the same
     hash is free and returns `alreadyReceived: true`.
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
- **Integrity on download:** files up to 16 MiB are verified completely before the first byte is sent, so
  corruption answers `409 FILE_CORRUPT` with both hashes. Larger files are streamed, and the connection is
  cut (never ended cleanly) if the hash turns out wrong. In both cases the file is marked `corrupt`.
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
| `GET /statistics/periods` | `{ data: Period[] }`. A period is a run of storm batches (`peak`) or of regular simulator batches (`normal`) over the last 7 days: `{ id, label, kind, origin, start, end }` |
| `GET /statistics/storage-fit` | `{ items: [{ category, storages: [{ storage, samples, p50Ms, p95Ms, throughputBps, errorRate }], recommendedStorage, interpretation }] }`, measured from the operations log over 7 days |
| `GET /statistics/period-comparison?a=&b=` | `{ periodA, periodB, rows: [{ category, metric, a, b, deltaPct }], interpretation }`, where `metric` is one of `p95Ms`, `opsPerS`, `errorRate` or `volume` |
| `GET /statistics/grid-insights` | `{ faultsByZone, consumptionByHourZone, anomalies, interpretation }` over the last 24 h. Anomalies are readings of zero or above 5x the zone average |

All of these need `view_statistics`.

## Monitoring and traces

| Method & path | Who | Notes |
|---|---|---|
| `GET /storage-health` | session | `{ data: [{ storage, status: ok|degraded|down, latencyMs, lastCheckAt, circuitState }] }`, from the health monitor (every 5 s) |
| `GET /metrics/bulkhead` | `view_observability` | `{ data: [{ category, active, queued }] }` for this replica |
| `GET /traces/{traceId}` | session | `{ traceId, operation, category, fileId, storage, startedAt, durationMs, status, spans: [{ spanId, name, startOffsetMs, durationMs, status, storage, errorCode }] }` |
| `GET /healthz`, `GET /readyz` | probes | `/readyz` stays **200** when a storage or the DB is down (`status: degraded`), as the README requires |
| `GET /metrics` | Prometheus | Text exposition |

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

## Metrics (confirmation for P1: the names match the README)

- **Uploads:** `filegrid_uploads_total{category,outcome}` and
  `filegrid_upload_duration_seconds{category,outcome}`. The outcome is one of `success`, `mismatch` or
  `error`. The duration runs from complete to durable.
- **Meter readings:**
  - `filegrid_meter_readings_stored_total{zone}` counts first stores only.
  - `filegrid_meter_readings_duplicates_total{zone}` counts deduplicated retries.
  - `filegrid_meter_readings_duplicate_stored_total` is always 0.
  - `filegrid_meter_batches_total{outcome}`.
- **Storages:** the P1 metrics unchanged: `filegrid_storage_operation_seconds`,
  `filegrid_storage_bytes_total`, `filegrid_storage_errors_total`, `filegrid_storage_up` and
  `filegrid_storage_circuit_state`.
- **Downloads and integrity:** `filegrid_downloads_total{category,outcome}`,
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
- **Not implemented yet:** `GET /api/docs-json` (Swagger), `GET /stream` (SSE), `GET /audit-events`,
  `GET /guarantees`, `GET /alerts`, `GET /metrics/matrix` and `Range` downloads. Use polling until SSE
  exists.
- **Extra endpoints:** `maxConcurrency` on policies and `POST /demo/storages/{storage}/{action}`.

## Answers to `docs/api/HANDOFF-backend.md`

1. **Routing:** `/api/v1` behind the existing Ingress (`/api`, no prefix stripping). The Service is
   `filegrid-backend:8000` (P1's manifests).
2. **Session:** cookie and CSRF exactly as described above, with the `me` shape from the proposal.
3. **Upload:** the custom chunk API with `202` and polling. Parts are staged in the policy's storage, not
   on the pod's disk.
4. **Errors and traces:** the error shape and `X-Trace-Id` are on every response. Traces come from the
   operations log.
5. **SSE:** not done yet (see above).
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
- `FILEGRID_DEMO_MODE` (default `true`)
- `SIMULATOR_URL` (default `http://filegrid-simulator.filegrid.svc:8080`)
- `SESSION_TTL_MINUTES` (480) and `SESSION_IDLE_MINUTES` (30)
- `COOKIE_SECURE` (default `true`)
- `FILEGRID_STORAGE_DRIVER=memory` (no S3/FTP; for local runs)
- `LOG_LEVEL`

Simulator variables: `BACKEND_URL`, `METER_API_KEY`, `METER_RATE` (default 10/s), `STORM_FACTOR` (10),
`PORT` (8080), `METER_COUNT`, `BATCH_MAX`, `DUPLICATE_RATIO` (0.02) and `MAX_RATE`.
