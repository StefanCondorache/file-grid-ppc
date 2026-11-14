# FileGrid PPC: Team Task Split

Source of requirements: `docs/brief/FileGrid_PPC.pdf`.

Stack:
- **Backend:** NestJS 12 (TypeScript, Node 26).
- **Frontend:** React + Vite.
- **Storage (already in `infra/`):** PostgreSQL, SeaweedFS (S3) and pure-ftpd (FTP).
- **Observability:** Prometheus, Grafana and Loki.
- **VPS:** k3s with Traefik and cert-manager on `ppc.filegrid.cc.cd`.

Already done: storage services (`make infra-up`) and the k3s TLS placeholder site.

## Ownership

Only edit your own folders. If you need a change in someone else's folder, ask them.

| Person | Role | Owns |
|---|---|---|
| **P1** | Infra, storage, security | `infra/`, `deploy/`, `Makefile`, `README.md`, `backend/src/storage/`, `backend/src/crypto/` |
| **P2** | Backend API, data, simulator | `backend/` (except `storage/` and `crypto/`), `simulator/`, `docs/api.md` |
| **P3** | Frontend | `frontend/` |

Each person writes the Dockerfile for their own part. P1 wires the Dockerfiles into compose and k8s.

**Contracts to agree in the first hour.** After that, change them only after telling the others:
- `backend/src/storage/base.ts` (P1 owns it, P2 uses it). It defines the storage adapter interface: `putStream(key, chunks) -> {size, sha256}`, `getStream(key)`, `delete(key)` and `health()`. It is the TypeScript port of the original Python `base.py`.
- `docs/api.md` (P2 writes it, P3 uses it). It is the REST API below. P3 builds against mocks until the real endpoints exist.

Draft API:
- `POST /api/auth/login`
- `GET /api/policies` and `PUT /api/policies/{category}`
- Resumable upload:
  - `POST /api/uploads` starts an upload and returns `upload_id` and `chunk_size`.
  - `PUT /api/uploads/{id}/chunks/{n}` sends one chunk.
  - `GET /api/uploads/{id}` lists the chunks already received, used for resume.
  - `POST /api/uploads/{id}/complete` finishes the upload.
- Files:
  - `GET /api/files?category=&q=&from=&to=` searches.
  - `GET /api/files/{id}/download` returns the file after checking its hash.
  - `GET /api/files/{id}/trace` returns the trace of one operation.
- `POST /api/meter-readings` (meter API key; idempotent on `reading_id`)
- `GET /api/stats/benchmark`, `GET /api/stats/peak-vs-normal` and `GET /api/stats/grid`
- `POST /api/demo/storm`, `POST /api/demo/corrupt/{file_id}` and `POST /api/demo/simulator`

## P1: Infra, storage, security

1. **Storage adapters** for S3, FTP and DB. Each one streams in chunks with constant memory and computes SHA-256 while streaming. Test them against `make infra-up`.
2. **Encryption of connection documents** with AES-256-GCM, streamed before the write. The key comes from env or secret and is never in the repo. Show that the raw object in storage can't be read.
3. **Health check and circuit breaker per storage.** A storage that is down fails fast and never blocks the other categories.
4. **One-command start.** `make up` brings up storage, backend, frontend and observability on a clean machine. Secrets are generated automatically, the way `gen-env.sh` does it. Update the README quickstart.
5. **Observability stack:**
   - Prometheus and Grafana, with a dashboard showing p50/p95/p99, throughput and error rate per category and per storage.
   - Loki, with logs searchable by trace ID.
   - Small retention and memory limits.
6. **Alerts when a business requirement is at risk:**
   - Meter readings lost or duplicated.
   - Fault-record uploads slow or failing.
   - A storage is down.
   - Video transfers failing.

   Alerts go to a notification channel, such as a Discord or Telegram webhook.
7. **VPS deploy on k3s.** Storages are ClusterIP only, with no outside access. The app is served over HTTPS through Traefik and scales through replicas, with no code change.
8. **Chaos scripts for the demo:** stop a storage, and degrade the network with `tc netem` (latency and packet loss).

### Stare P1 (14.11.2026, 13:50; hardening după verificarea live: unit în `feat/handoff` și deployat)

Codul P1 e pe `main`. Contractele de integrare sunt în README, secțiunea „Contracte pentru P2/P3”.

| # | Stare |
|---|---|
| 1 | ✅ Adaptoare async S3/FTP/DB (memorie constantă, SHA-256), portate în TypeScript în `backend/src/storage/` |
| 2 | ✅ Criptare AES-256-GCM pe stream în `backend/src/crypto/` (cheia din Secret-ul `filegrid-app-secrets`) |
| 3 | ✅ Circuit breaker, health monitor și metrici per storage |
| 4 | ✅ `sudo make up` pornește k3s, HTTPS, storage, observabilitatea și aplicația (pentru fiecare folder cu `Dockerfile`). A doua rulare: `helm` sărit pentru release-urile neschimbate (checksum în `monitoring/obs-helm-checksums`), imagini cu același digest (`--provenance=false`), placeholder-ul gestionat doar de `make app-up`, `make status` cu fiecare host o dată. Parola conturilor demo separată (`DEMO_USERS_PASSWORD`, adăugată fără rotirea celorlalte chei) |
| 5 | ✅ Prometheus, Grafana la `/grafana` (dashboard `filegrid-overview`; parola cu `make grafana-password`), Loki + Alloy. Grafana: cookie `Secure`/`SameSite=Strict`, `/metrics` nepublic, fără phone-home, versiune ascunsă; limite ridicate (Grafana 256Mi, sidecar 160Mi, Alloy 192Mi) |
| 6 | ✅ 12 reguli de alertă: 7 de business (`MeterReadingsLost` pe gauge-ul `filegrid_meter_readings_lost`, ca „Pierdute” din dashboard) + 5 de infrastructură (`TargetDown`, `PodCrashLooping`, `ContainerMemoryNearLimit`, `NodeMemoryHigh`, `NodeDiskHigh`; node-exporter fără rețeaua gazdei); `make obs-rules-test` (promtool + teste unitare). Fără webhook (notificările se activează din Secret-ul `monitoring/alertmanager-config`) |
| 7 | ✅ Storage doar ClusterIP + NetworkPolicy (`make storage-isolation-check`); blackbox-exporter doar de la podul Prometheus server; manifestele aplicației sunt în `deploy/k8s/app/` (preStop 5 s + 30 s grație pe backend/simulator). HTTPS: HSTS, nosniff, Referrer-Policy, X-Frame-Options pe toate Ingress-urile; IP-ul real al clientului (`externalTrafficPolicy: Local`, X-Forwarded-* crezute doar din CIDR-ul podurilor). Criptarea Secret-elor k3s at rest: **oprită** până la `sudo make k3s-secrets-encrypt` (pregătită, nerulată) |
| 8 | ✅ `make chaos-storage-stop/start S=…`, `make chaos-netem-on/off` (doar în rețeaua podului), RBAC pentru panoul demo |

**Rămas de făcut (oricine din echipă):**
- [x] Rulați `sudo make up` de două ori pe VPS după merge: a doua rulare nu trebuie să schimbe nimic. Apoi `make storage-isolation-check`. **Făcut 14.11:** a doua rulare nu a repornit nimic (aceleași poduri, 0 restarturi); singura linie `configured` e `ValidatingAdmissionPolicy` `filegrid-demo-storage-scale-0-or-1`, cosmetică (`kubectl diff` gol). Izolare: **30/30**.
- [x] Repetiție de chaos live: `make chaos-storage-stop S=s3`; categoriile pe FTP/DB trebuie să meargă în continuare; apoi `make chaos-storage-start S=s3`. Netem a fost testat doar pe un pod de unică folosință. **Făcut 14.11** (prin API-ul demo, același ca panoul): cu S3 oprit, fault records au mers pe fallback `db`, video pe FTP și contoarele pe DB au continuat (0 pierdute); `FileGridStorageDown(s3)` + `FileGridCircuitOpen(s3)` au pornit în ~1,5 min și s-au stins după repornire. Netem pe podul backend real (300 ms ± 50 ms, 5% pierderi): API ~0,35 s în loc de 0,04 s, backend gata; `chaos-netem-off` a curățat complet.
- [x] ~~Testele de integrare ale adaptoarelor, în cluster: `backend/app/storage/tests/run-in-cluster.sh`.~~ Înlocuit: adaptoarele Python au fost portate în TypeScript (`backend/src/storage/`) și verificate pe storage-urile din cluster (vezi „P2 status”). Fix-ul FTP keep-alive (b66395d) e inclus în portare; review independent făcut pe codul TypeScript.
- [x] Ultimul re-review pentru fix-urile k8s (pin k3s/Helm, timeout Traefik, ordinea storage → TLS în `make up`) a fost oprit înainte de final: o trecere rapidă prin `git show fd79ace eb23ac0`. **Făcut 14.11:** corecte; `readTimeout` 900 s acoperă părțile de upload (16 MiB la 1 Mbit/s ≈ 2-3 min).
- [x] RAM: rămân ~0,9 GiB liberi cu observabilitatea pornită. Puneți `resources.limits` pe backend/frontend/simulator (sunt deja în `deploy/k8s/app/`) și urmăriți `kubectl top pods -A`. **Făcut 14.11:** limite backend 384Mi (heap V8 192 MB), simulator 128Mi, frontend ridicat la 256Mi (cererea P3). Măsurat: backend ~170-180Mi, simulator ~40-50Mi, toate podurile ~1,35 GiB, ~1,2 GiB disponibili pe gazdă.
- [x] P2: confirmați numele metricilor și valorile `outcome` din README (alertele și dashboard-ul depind de ele) și faptul că `filegrid_sim_readings_sent_total` numără citiri unice. **Confirmat** (vezi „P2 status” și `docs/api.md`); Prometheus scrapează backend-ul (fix Content-Type `a96d1fa`), iar `MeterReadingsLost` arată 0.
- [ ] Opțional: webhook Discord/Telegram pentru alerte (vezi comentariul din `deploy/k8s/observability/prometheus-values.yaml`).
- [ ] Deploy `p1/hardening` (împreună cu `p2/demo-fixes`, care adaugă gauge-ul `filegrid_meter_readings_lost` și `TRUSTED_PROXY_CIDRS` în backend): `sudo make up` de două ori; la a doua rulare toate release-urile helm trebuie să spună `skipping helm upgrade`. Apoi verificați header-ele (`curl -sI https://<DOMAIN>/`, `/api/v1/...`, `/grafana/login`), `/grafana/metrics` → 302, IP-ul real în auditul unui login și `make storage-isolation-check`.
- [ ] Decizie: `sudo make k3s-secrets-encrypt` (criptarea Secret-elor în datastore-ul k3s; repornește k3s o dată, ~1 minut fără API). Până atunci Secret-ele stau necriptate pe discul VPS-ului.

## P2: Backend API, data, simulator

1. **FastAPI skeleton and Postgres metadata schema:** files, upload sessions, chunks, policies, meter readings and an audit log. Users authenticate with JWT; meters use an API key.
2. **Policy engine.** Each category has a policy in the DB with: primary storage, fallback storage, encryption, chunk size and concurrency limit. `GET/PUT /api/policies` changes it live, with no code change.
3. **Resumable chunked upload, stateless.** Session state lives in the DB, so any instance can continue an upload. Data streams to the adapters. A file is confirmed only after a durable write.
4. **Download with integrity check.** SHA-256 is recomputed while streaming; a mismatch returns an error and marks the file as corrupted. Plus the search API.
5. **Meter readings endpoint.** Idempotent (unique `reading_id`), with batch inserts. Retries never lose or duplicate a reading.
6. **Bulkhead.** Separate concurrency limits or worker pools per category, so a 10x spike in one category doesn't slow the others.
7. **Tracing and metrics.** A trace ID follows every step: API, policy, encryption, storage, audit. Prometheus metrics are labelled by category, storage and operation.
8. **Meter simulator** in `simulator/`. The rate is configurable (normal, or storm at 10x). It covers the regions Muntenia, Banat and Dobrogea, and sends retries and duplicates on purpose.
9. **Stats endpoints:**
   - A storage benchmark per category.
   - A normal-day vs peak-day comparison.
   - Grid insights: consumption peaks, anomalies and the regions with the most faults.

   Each comes with a short plain-language interpretation.

### P2 status (14.11.2026, 18:30)

The P2 code is on branch `feat/p2-backend-nest` (pushed to `origin`, merged with `main`, no conflicts). The backend is **NestJS 12** (TypeScript), not FastAPI. P1's storage adapters and encryption were ported to TypeScript in `backend/src/storage/` and `backend/src/crypto/`, with the same metrics, env variables, `blobstore` schema and FGE1 format. The REST contract is in [`docs/api.md`](docs/api.md), under `/api/v1`.

| # | Status |
|---|---|
| 1 | ✅ Metadata schema (Kysely, migration under an advisory lock). Session in the `__Host-fg_session` cookie (8 h, 30 min idle) + CSRF check. The 5 roles with the capability matrix; one demo account per role in demo mode. Meter API key |
| 2 | ✅ Policies live in the DB, with versions, change history and 409 on a stale `baseVersion`; connection documents always encrypted |
| 3 | ✅ Stateless resumable upload in parts: parts staged in the policy's storage (`staging/…`), fallback when the primary is down, file confirmed only after a durable write and a matching SHA-256 |
| 4 | ✅ Download with the SHA-256 recomputed (409 `FILE_CORRUPT`, or a cut connection for big files; the file is marked corrupt). Search, custody, audited personal-data reveal |
| 5 | ✅ Meter readings idempotent on `readingId`, in batches; never stored twice; metrics as in the README |
| 6 | ✅ Bulkhead per category (`maxConcurrency` from the policy, read live); 503 `CATEGORY_BUSY` when full |
| 7 | ✅ `X-Trace-Id` on every response, operations log (`GET /api/v1/traces/{id}`), `/metrics` |
| 8 | ✅ Simulator in `simulator/` (no runtime dependencies; normal, 10x storm, custom, stopped; deliberate retries and duplicates; `Dockerfile` on port 8080) |
| 9 | ✅ Statistics with Romanian interpretations. Demo panel endpoints: storm, corrupt a file, stop/start S3/FTP through the Kubernetes API |

Tests: 138 backend (embedded Postgres; S3 and FTP adapters against in-process S3/FTP servers) and 87 simulator, all passing. A local end-to-end run (backend + simulator) stored 1,263 of 1,263 unique readings, rejected the deliberate duplicates and lost none.

**Answers for P1:** the metric names and `outcome` values in the README are confirmed (`success` / `mismatch` / `error` for uploads), and `filegrid_sim_readings_sent_total` counts unique readings. Details are in `docs/api.md`, section "Metrics".

**Left to do:**
- [x] Test the S3/FTP adapters against the real storages in the cluster (14.11, through `kubectl port-forward`): health, 1 KB and 20 MiB objects with matching SHA-256, early stop, missing object, cleanup. Note: the first FTP operation of a process takes ~4-6 s (pure-ftpd login), later ones reuse the connection.
- [x] Build the `backend/` and `simulator/` images and run `make app-up` on the VPS. Check `/readyz`, a login and an upload over HTTPS. **Done 14.11:** built and deployed by `sudo make up` (run twice, idempotent); over HTTPS: login (`__Host-` cookie), CSRF, one upload per category with matching SHA-256 after download, masked personal data, traces, 1,172/1,172 readings stored and 0 lost. Found and fixed on the VPS: `/metrics` was served as text/html, so Prometheus rejected the scrape (`a96d1fa`).
- [x] Demo rehearsal: storm, stop S3 (fault records must move to the `db` fallback), corrupt a file then download it. **Done 14.11** through the demo API: 10x storm, S3 stopped (fault records on the `db` fallback, FTP and DB categories unaffected, 0 readings lost, `FileGridStorageDown(s3)` fired and cleared), S3 restarted, corrupted file answered `409 FILE_CORRUPT` and was marked corrupt.
- [ ] P3: switch the mocks to the real API. Category ids are P1's (`fault_records`, `s3`…); see "Differences from the frontend proposal" in `docs/api.md`.
- [x] Known limits from the code review: **fixed** (merged `ed83f8f`). A primary that is known down is skipped before the body is read; a full DB pool answers 503 `CATEGORY_BUSY` and no longer opens the circuit; the S3 read timeout runs only while waiting on S3; a slow FTP health login no longer counts as a failed probe.
- [ ] Optional: `GET /api/v1/stream` (SSE), `/api/docs-json` (Swagger), `/audit-events`, `/guarantees`, `/alerts`, downloads with `Range`. **Mostly done** (merged `ed83f8f`): SSE `/stream`, `/audit-events`, `/guarantees`, `/alerts` (+ acknowledge), `/metrics/matrix`, bulkhead series and `Range` (206/416) are implemented and tested (199 backend tests). **Done 14.11 evening** (branch `p2/backend-tasks`, see below): `GET /api/v1/docs-json` and the `docs/api.md` sections.

### P2 parallel tasks (from the `feat/handoff` guide, 14.11.2026, evening; merged 15.11)

All the P2 work of the guide is on **one branch, `p2/backend-tasks`** on `origin` (`StefanCondorache/file-grid-ppc`), cut from `main` after `feat/handoff` was merged into it (PR #8). It merges the five task branches below (now deleted) plus the fixes of 15.11, with no conflict left; open one PR from it towards `main`. Full backend suite on it: **286/286** (33 suites), typecheck and lint clean.

| Guide task | Was branch | What it adds | Tests on that branch |
|---|---|---|---|
| 4 · Full trace | `p2/trace-spans` | Root `api` span (method, path without query, upload id and part number), `encryption` span (AES-256-GCM, key id, size, time in the cipher), `audit` span; every uploaded part is an `upload.part` operation with its own `traceId` (also when refused); only allow-listed span attributes are stored; `GET /traces/{id}` answers the same 404 as an unknown id to a role that may not see the category. A connection document reads `api → policy → encryption → storage.put → audit → confirm`. | 268/268 |
| 6 · API docs | `p2/api-docs` | `GET /api/v1/docs-json` (public), the OpenAPI document of the real API: the proposal corrected to what the backend answers. A test fails when a Nest route is missing from it (or it has one Nest lacks), when a real answer or live SSE event does not match its schema, or when a `$ref` dangles. `docs/api.md` now describes the `/stream` events and payloads, `/metrics/matrix`, the bulkhead series, `Range` and the session rule for background GETs. Also fixed there: policy versions answer the `GET /policies` shape (the seeded v1 was a raw DB row), and `/demo/status` no longer shows the storage probe detail (it named the S3 bucket). | 269/269 |
| 5 · Demo data | `p2/demo-seed` | `npm run seed:demo` (in `backend/`, `FILEGRID_URL=https://<host>`): 60 fault records (Dobrogea 27, Muntenia 21, Banat 12; the substation names carry the county, e.g. `Stația 110 kV Medgidia (CT)`), 20 connection documents (PDF, invented applicants and CNPs, encrypted by policy, uploaded by `racordari`), 4 short drone videos (ffmpeg test pattern; skipped without ffmpeg), each uploaded by its demo account. Idempotent (`seed-…`, `RC-SEED-…`). `GET /statistics/grid-insights` then shows three zones with different fault counts. Not run on the VPS: the guide runs it together after the final deploy. | 262/262 |
| 3 · 1 GB proof | `p2/proof-1gb` | `backend/scripts/proof-1gb-upload.ts`: 1.1 GiB through the resumable API, streamed download, SHA-256 comparison, memory of every backend pod per phase (`PROOF_MEMORY_CMD`), markdown tables. **Run on the VPS: passed** (results below). Tested locally at 40 MiB. This branch also holds this TASKS.md section. | 263/263 |
| Follow-up of the proof | `p2/upload-hygiene` | A part sent again is answered only after its body is read; abandoned uploads lose their staged parts every `UPLOAD_SWEEP_INTERVAL_S`. | 273/273 |

**For the frontend (Mihail):** `API_SPEC=https://<host>/api/v1/docs-json npm run gen:api` generates the types from the real API. Measured on the current `feat/handoff` frontend (`tsc --noEmit`, compared with its own 73 existing errors), the switch adds 27 type errors: 26 in `src/mocks/` and test files (category ids `fault_records`, storage ids `s3`, `storageControl` gone from `DemoStatus`) and 1 in a screen, `src/features/audit/AuditTable.tsx:34` (an audit actor's role can be `null`, e.g. a system actor). `fallbackAvailable` (read by "Restaurează din rezervă"): **settled 15.11**, `409 FILE_CORRUPT` now sends `fallbackAvailable: false`, because each file is stored once and there is no copy to restore; the screen then shows "notify the storage team". Still for P3: `AuditTable.tsx:34` must accept a `null` actor role.

**1 GB proof results (VPS, NestJS backend `1040608`, 14.11.2026 20:49). ✅ Requirement met.** 1,126 MiB went through the public domain (Traefik → backend → FTP, the `drone_videos` policy), came back with the same SHA-256, and no backend pod grew by more than 29 MiB (the budget is +64 MiB). The memory was sampled every 2 s, before and during each phase, on all 3 backend pods (the HPA was at 3): the RSS of the node process (`VmRSS` of PID 1 through `kubectl exec`, instant) and `kubectl top` (cgroup working set, averaged over 15-60 s). Run on the VPS host (Node 26.13 is installed there) from a copy of the script in `/tmp`, removed afterwards:

```
FILEGRID_URL=https://ppc.filegrid.cc.cd PROOF_SAMPLE_S=2 PROOF_MEMORY_CMD='sh memory.sh' \
node backend/scripts/proof-1gb-upload.ts
# memory.sh: for each pod of `kubectl -n filegrid get pods -l app=filegrid-backend`:
#   kubectl exec <pod> -- grep VmRSS /proc/1/status  -> "<pod>-rss <n>Mi"
#   then `kubectl top pod -l app=filegrid-backend`    -> "<pod>-top <n>Mi"
```

| Size | Parts | Part retries | Upload s | Complete s | Download s | Stored on | SHA-256 after download |
|---|---|---|---|---|---|---|---|
| 1126 MiB | 71 x 16 MiB | 0 | 15.9 | 22.4 | 14.5 | ftp | match |
| 100 MiB (trial) | 7 x 16 MiB | 0 | 3.5 | 2.9 | 1.2 | ftp | match |

| Backend pod (1126 MiB run) | Baseline MiB | Upload peak | Complete peak | Download peak | Growth MiB | Under +64 MiB |
|---|---|---|---|---|---|---|
| fdvhm, node RSS | 210 | 218 | 219 | 219 | 9 | yes |
| gzvhz, node RSS | 209 | 222 | 230 | 238 | 29 | yes |
| p942j, node RSS | 222 | 238 | 238 | 236 | 16 | yes |
| fdvhm, kubectl top | 160 | 160 | 165 | 165 | 5 | yes |
| gzvhz, kubectl top | 155 | 155 | 183 | 183 | 28 | yes |
| p942j, kubectl top | 209 | 209 | 224 | 224 | 15 | yes |

"Complete" is the server re-reading the 71 staged parts, hashing them and writing the final object: 1.1 GiB in 22 s with at most 29 MiB more memory, so memory does not follow the file size. The test data stays on the FTP storage (no delete in the API): the proof file (1,126 MiB) and two 100 MiB trial files (`test-p2-proof-1gb-*.bin`). The staged parts of three failed trial runs were removed by aborting their uploads (`DELETE /uploads/{id}`).

**Found while running the proof (to follow up):**
- **HTTP/2 between Node's `fetch` and Traefik:** with Node 26's `fetch` (HTTP/2), some part answers never reached the client (stream reset `NGHTTP2_ENHANCE_YOUR_CALM`), although the backend had stored the part (`200` in its log). curl over HTTP/2 and HTTP/1.1 never lost one, so the script now sends the parts over HTTP/1.1 keep-alive (0 retries since). Not checked: whether browsers hit it with the upload screen's 4 parallel parts (to see in the manual browser test).
- **P2, backend:** a part sent again with the same `X-Part-SHA256` is answered `alreadyReceived` before its body is read. Over HTTP/2 the server then closes the stream while the client is still sending 16 MiB, so the client sees an error and retries again (seen 4 times in a row). **Fixed** on `p2/backend-tasks`: the body is read before the answer (test `part-retry.e2e-spec.ts`).
- **P2, backend:** abandoned uploads (never completed nor aborted) keep their staged parts forever. A session is marked `expired` only when it is touched, and its parts are not dropped. **Fixed** on `p2/backend-tasks`: every `UPLOAD_SWEEP_INTERVAL_S` (300) each replica expires them and drops the staged parts of expired and aborted sessions; a part whose storage is down is kept for the next sweep (test `upload-sweep.e2e-spec.ts`).

**Review minors, fixed 15.11 on `p2/backend-tasks`:** a download is recorded in the operations log even when its audit insert fails (test with a Postgres trigger that refuses it); a failed encrypted write keeps its `encryption` span, marked `error`; the OpenAPI document now requires `PartReceipt.traceId` and the span `parentSpanId`/`attributes`. Left as is: the response-conformance test accepts extra fields (a generated client ignores them; the `/demo/status` probe detail has its own test).

## P3: Frontend

1. **App shell:** React + Vite, login, layout, and an API client running on mocks from `docs/api.md`.
2. **Upload page** for fault records, connection documents and drone videos. Chunked upload with progress, automatic resume after the connection drops, and retry with backoff.
3. **Search and download page.** Filters for category, date and name, an "integrity verified" badge, and a trace view per file.
4. **Policies page** to edit each category's storage policy, with no code change.
5. **Statistics page.** Benchmark matrix (which storage fits each category, and why), a normal vs storm comparison, and grid insights per region. Each panel includes its interpretation text.
6. **Demo panel** for the jury:
   - Start a 10x storm.
   - Stop or start a storage.
   - Corrupt a file.
   - Slow the network down.
   - Link to Grafana.

### Stare P3 (14.11.2026)

Frontendul e **Next.js 16 (App Router) + TypeScript**, nu React + Vite. Codul e pe branch-ul `frontend`, în `frontend/`. Documentația e în `docs/frontend/` (PRD, arhitectură, design, machete), `docs/adr/` (ADR 0001–0022) și `docs/api/` (propunerea OpenAPI, handoff, sincronizare cu backend-ul). Planul complet, cu 78 de task-uri, e în `docs/superpowers/plans/2026-11-14-filegrid-frontend.md`.

| Etapă | Stare |
|---|---|
| PRD, arhitectură, model de amenințări, accesibilitate | ✅ `docs/frontend/` + ADR 0001–0022 |
| Contract API (propunere) + handoff pentru backend | ✅ `docs/api/openapi.frontend-proposal.yaml`, `HANDOFF-backend.md` |
| Design: tokeni PPC, temă „dispecerat”, font Figtree, machete pentru 6 ecrane | ✅ `docs/frontend/design/` |
| 5 · Fundație: Next.js, tokeni, i18n, client API tipat, mock-uri MSW din OpenAPI, CSP, imagine Docker (port 8080, uid 101, ~45 MiB) | ✅ |
| 6a · Login cu listă de roluri + parolă, shell, navigare pe roluri, comutator de rol demo, expirarea sesiunii, flux live (SSE + polling) | ✅ 95 de teste unitare + 6 e2e (Edge, axe WCAG 2.2 AA) |

Comutare mock / backend real: `NEXT_PUBLIC_API_MOCKS=1` (implicit în dev) sau `0` (NestJS). `NEXT_PUBLIC_API_MOCK_GROUPS=…` pune doar unele grupuri pe mock. Un build de producție cu mock-uri e refuzat dacă nu e setat explicit `FILEGRID_ALLOW_MOCKS=1`. Pe mock-uri, parola pentru toate cele 5 conturi demo e `demo-2026`.

**Rămas de făcut (P3):**
- [ ] 5.15 · Primul deploy pe VPS. **P1:** ridicați limita de memorie a frontend-ului de la 128Mi la 256Mi în `deploy/k8s/app/frontend/`. Imaginea ascultă pe 8080, ca uid 101.
- [ ] 6b · Upload reluabil (bucăți, hash SHA-256 în worker, reluare după reload/offline, grilă de bucăți)
- [ ] 6c · Fișiere, detaliu, integritate (hash client = server, „Fișier corupt detectat”), trasare, date personale mascate
- [ ] 6d · Politici (editare live, diff, versiuni, conflict)
- [ ] 6e · Garanții de business, banda de sănătate storage, alerte, matrice categorie × storage, grafic de izolare
- [ ] 6f · Statistici S1/S2/S3 cu interpretare
- [ ] 6g · Cameră de control demo (furtună, oprire S3, corupere fișier, simulator) + contoare live
- [ ] 6h · Jurnal de audit, test de integrare între etape, pas final de accesibilitate, repetiții, video de rezervă

**Am nevoie de la P2 (detalii în `docs/api/backend-sync-2026-11-14.md`):**
- [x] Login: pe lângă JWT, setați și cookie-ul `__Host-` httpOnly. `EventSource` și link-urile de download nu pot trimite header-ul `Authorization`. **Făcut (P2):** sesiunea e cookie-ul `__Host-fg_session` (Secure, HttpOnly, SameSite=Strict) + verificare CSRF; bearer acceptat doar pentru scripturi.
- [x] Cinci roluri (`teren`, `dispecerat`, `racordari`, `auditor`, `admin`) în loc de două. Demo-ul arată date personale mascate pentru `racordari` și dezvăluite doar de `auditor`. **Făcut (P2):** matricea din PRD FE-01, un cont demo per rol, comutator de rol pentru admin, `reveal` doar pentru `auditor`.
- [x] Un singur set de nume de categorii, comun cu P1 (metrici, dashboard-uri). **Făcut (P2):** `meter_readings`, `fault_records`, `connection_documents`, `drone_videos` peste tot (API, metrici, alerte).
- [ ] `@nestjs/swagger` cu `/api/docs-json`, ca să generăm tipurile din API-ul real. **Încă nefăcut** (planificat ca document OpenAPI static servit de backend, vezi planul de la final).
- [x] Jurnalul operațiilor (trace, metrici), tag-ul `origin`, perioade etichetate (S2) și pragurile garanțiilor. **Făcut (P2):** `/traces/{id}`, `origin`, `/statistics/periods`, iar `/guarantees` are praguri din env (`GUARANTEE_*`, cu valori implicite).
- [x] Confirmare: `GET /auth/me` nu prelungește sesiunea (doar `POST /auth/refresh` și activitatea reală). **Făcut (P2):** `/auth/me`, `/stream` și GET-urile de monitorizare cerute periodic nu mută fereastra de inactivitate.

#### Prompturi pentru task-urile rămase

Sursa: `docs/frontend/PROMPTS.md` (șablonul 6a–6h, Prompt 7, 8, 9). Pentru 5.15, promptul e scris după planul `docs/superpowers/plans/2026-11-14-filegrid-frontend.md` (Task 5.15). Prompturile au fost scrise înaintea planului și a ADR-urilor. Când diferă de ele (de exemplu: auth fără middleware, grafice proprii Recharts în loc de panouri Grafana încorporate, i18n fără next-intl, branch `fe/<slice>`), **planul și ADR-urile au prioritate**. Ordinea de merge: 6e înainte de 6g; 6b, 6c, 6d, 6f și 6h.1 (audit) pot rula în paralel.

**Șablon comun pentru 6b–6h** (se lipește blocul SLICE al task-ului în locul `<paste one of the blocks below>`):

```text
Read frontend/CLAUDE.md, docs/frontend/context.md, the plan in docs/superpowers/plans/, the
relevant ADRs and docs/frontend/design/*.
Use superpowers:using-git-worktrees (branch feat/frontend-<slice>).
Use superpowers:subagent-driven-development to execute ONLY the tasks of the slice below,
with superpowers:test-driven-development on every task (red → green → refactor, and show the
failing test first). Use ecc:react-patterns, ecc:frontend-patterns and ecc:typescript-patterns.
After each task: ecc:react-reviewer + ecc:typescript-reviewer on the diff, then fix the findings.
At the end of the slice:
- ecc:a11y-architect audits the new screens. Fix the issues.
- ecc:e2e-runner adds the Playwright journey for this slice's demo beat.
- ecc:silent-failure-hunter checks error paths (no swallowed errors, every failure visible).
- superpowers:verification-before-completion: build, typecheck, lint, unit, e2e. Paste the output.
- Take screenshots of each new screen (light + dark) and show them to me.
Then use superpowers:finishing-a-development-branch.

SLICE:
<paste one of the blocks below>
```

**5.15 · Primul deploy pe VPS** (prompt din planul Task 5.15 + `docs/frontend/demo-day-matrix.md`):

```text
Read docs/superpowers/plans/2026-11-14-filegrid-frontend.md (Task 5.15) and
docs/frontend/demo-day-matrix.md. Do not edit P1's files under deploy/; propose changes instead.
1. Build the image off-VPS (`npm run image:real` in frontend/), save it and import it into k3s.
2. With P1: set PORT=8080, run as uid 101, and raise the frontend memory limit to 256Mi in
   deploy/k8s/app/frontend/ (or keep 128Mi and set NODE_OPTIONS=--max-old-space-size=96).
3. Roll out and check https://ppc.filegrid.cc.cd/healthz = ok and / = login page, no CSP
   violations in the console, no service worker registered in the real image, and
   `kubectl top pods -n filegrid` under the limit.
4. Write the exact deploy commands into docs/frontend/demo-day-matrix.md. Paste real outputs.
```

**6b · Upload reluabil** (SLICE):

```text
Implement the upload engine exactly as decided in docs/frontend/architecture/upload-engine.md
and its ADR. Use ecc:error-handling.
- Pure TS core, framework-free and 100% unit tested: chunk planner, retry with exponential
  backoff + jitter, resume from server state, a queue with per-category concurrency, and a
  state machine (queued → hashing → uploading → paused → retrying → verifying → done | failed).
- Web Worker for incremental SHA-256 (hash-wasm), streaming by Blob.slice. Prove constant
  memory: a test or a script that uploads a generated 1.5 GB file while logging heap usage.
- Persist sessions in IndexedDB so a browser reload resumes. Listen to online/offline.
- UI: dropzone per category with type and size validation, metadata form (zona/regiune,
  stație, incident, client ID for racordări), multi-file queue, and the CHUNK-GRID progress
  visual (the "FileGrid" signature: each cell is a chunk; it fills, flashes on retry, turns
  green when verified), speed, ETA, retries counter, pause/resume/cancel.
- Final step: compare the client hash with the server hash and show the integrity badge.
- Playwright: throttle and drop the network mid-upload (route abort + offline emulation),
  reload the page, and assert the upload completes with a matching hash and no manual step.
```

**6c · Fișiere, integritate, trasare** (SLICE):

```text
Fișiere: search by name, category, date range, zone and status. Server-side pagination,
sortable data table, saved filters in the URL. Download through the API only. Verify the
SHA-256 of the downloaded stream in a worker and show "Integritate verificată" or a red
"Fișier corupt detectat" state, with the expected vs actual hash.
Detaliu fișier: metadata, storage used (S3/FTP/DB) and why (the policy at upload time),
encryption status, a chain-of-custody timeline, and a trace waterfall (spans with durations)
with a "Deschide în Grafana/Loki" deep link by trace ID. PII fields on connection documents are
masked by default; revealing them is role-gated and logged.
```

**6d · Politici** (SLICE):

```text
Politici: one card per category showing the active policy (primary storage, fallback,
encryption, chunk size, concurrency limit, retention). Editing uses react-hook-form + zod
with validation that mirrors the backend. Show a diff of old vs new before confirm, a
"takes effect immediately, no deploy" note, the change history (who and when), and
optimistic update with rollback on error. Admin role only.
```

**6e · Garanții de business și observabilitate** (SLICE):

```text
Use the dataviz skill and ecc:dashboard-builder.
Garanții de business: 4 status cards, one per row of table 2.1, each with its proving metric
and state (OK / în pericol / încălcat), live via SSE or polling per the ADR. Active alerts
list with severity, time and the requirement at risk. A storage health strip (S3, FTP, DB:
up/down, circuit breaker state).
Observabilitate: a category × storage matrix with p50/p95/p99, throughput and error rate, and
sparklines. Decide (ADR) between embedding Grafana panels and rendering our own charts from a
backend metrics endpoint; in either case link to the full Grafana dashboard.
```

**6f · Statistici S1/S2/S3** (SLICE):

```text
Use the dataviz skill. Every panel = chart + a 2–3 sentence Romanian interpretation +
a "Recomandare" line. Interpretations come from the backend or are generated from the
numbers with clear templates. No lorem ipsum.
1. "Ce storage pentru ce categorie": the benchmark matrix (latency, throughput, errors,
   cost/complexity notes) with the recommended storage per category and the reason.
2. "Zi normală vs zi de vârf": side by side, showing which categories degraded and which
   stayed flat (the bulkhead proof).
3. "Ce spun datele despre rețea": a map of Muntenia/Banat/Dobrogea (county-level GeoJSON,
   open data, attributed) with fault density, consumption patterns by hour, meter anomalies
   (spikes, zero readings, suspected tampering), and the top zones by faults.
A data-table alternative for every chart (a11y). Export to PNG/CSV.
```

**6g · Cameră de control + contoare live** (SLICE, după merge-ul 6e):

```text
Demo (admin only, hidden behind a flag in production): big projector-friendly controls for
a 10x storm per category, simulator rate (normal ↔ vârf), stop/start a storage, corrupt a
file, degrade the network, and reset. Every action needs confirmation, shows what happened
and links to its evidence.
The same screen shows live: per-category latency (the bulkhead proof), storage health, the
meter ingest rate, the dedup counter (duplicates rejected, readings lost = 0) and alerts
firing. This screen IS the demo, so design it for a 1920×1080 projector at 3 m distance.
Contoare: a live meter feed (readings/s by region, latest readings, duplicate/retry stats).
```

**6h · Audit, integrare, calitate, repetiții**. Patru prompturi, în ordine.

6h.1 Audit (SLICE, poate rula în paralel cu 6b–6f):

```text
Audit: an immutable log of who uploaded, viewed, downloaded or revealed PII on connection
documents, filterable and exportable. Optional English locale through next-intl. Dark
"dispecerat" theme toggle. Micro-interactions with ecc:make-interfaces-feel-better and
ecc:motion-patterns (honouring reduced motion).
```

6h.5 Trecerea la backend-ul real (Prompt 7):

```text
Read frontend/CLAUDE.md and docs/api/*. My teammates' NestJS backend exposes OpenAPI at
<URL>/api-json. Use ecc:contract-first:
1. Regenerate types with `gen:api` from the REAL spec and diff them against
   openapi.frontend-proposal.yaml. List every mismatch (paths, fields, enums, errors,
   pagination, upload protocol, auth cookie, stream format).
2. For each mismatch, propose the smallest fix and say on which side it belongs. Fix only the
   frontend side, and write the backend asks into docs/api/HANDOFF-backend.md.
3. Run with NEXT_PUBLIC_API_MOCKS=0 against the backend via `make up` (or the compose the team
   uses). Use ecc:e2e-runner to run every Playwright journey against the real stack, and
   superpowers:systematic-debugging for each failure (root cause first, no guess-fixes).
4. Confirm that uploads go straight to NestJS (not through Next) by checking network traffic
   and container memory during a 1.5 GB upload.
Paste real outputs. STOP with a list of what works end-to-end and what does not.
```

6h.0–6h.4 Integrare și verificare de calitate (Prompt 8):

```text
Use superpowers:dispatching-parallel-agents to review the whole frontend/ IN PARALLEL:
ecc:react-reviewer, ecc:typescript-reviewer, ecc:security-reviewer (against
docs/frontend/architecture/threat-model.md; also scan for secrets), ecc:a11y-architect
(WCAG 2.2 AA), ecc:performance-optimizer (bundle size, Server vs Client components, chart
lazy-loading, worker usage), and ecc:silent-failure-hunter.
Merge the findings into one list ranked by demo impact, and use superpowers:receiving-code-review
to judge each one (push back on wrong ones with evidence). Fix the rest with TDD.
Then run ecc:browser-qa on all screens at 1440×900, 1920×1080 (projector) and 390×844
(field team on a phone), light and dark, and fix the visual defects.
Finish with /ecc:gan-design polish on the 5 demo screens (at most 2 iterations) and
superpowers:verification-before-completion with real command output.
```

6h.6 Repetiții și video de rezervă (Prompt 9):

```text
Read docs/frontend/prd.md (demo script) and the running stack.
1. Update the 7-minute demo script into docs/frontend/demo-script.md with exact clicks, the
   expected screen, the requirement it proves (brief section number), and a fallback for
   each beat if something fails live.
2. Use ecc:e2e-runner to turn the script into ONE Playwright "demo rehearsal" spec that runs
   end-to-end against the real stack, so we can rehearse unattended and catch regressions.
3. Use ecc:ui-demo to record a backup video of the full demo in case the venue network fails.
4. Prepare seed data: realistic files per category, 2 storms in history, at least one
   corrupted file, and an anomaly region, so statistics look meaningful from minute one.
5. Final check from a clean clone: one command brings everything up per the README, the
   frontend is reachable over HTTPS on ppc.filegrid.cc.cd behind auth, and no secret is in git.
Report pass/fail per beat with evidence.
```

## Milestones

1. **M1:** adapters, upload/download API, and the UI shell on mocks.
2. **M2:** all 4 categories work end to end from the UI, with hashes verified.
3. **M3:** non-functional requirements: bulkhead, resume, encryption, failover, dashboards, alerts.
4. **M4:** statistics and the demo panel, a one-command start on a clean machine, and a demo rehearsal.

The VPS has 4 GB RAM and 2 cores, so every container needs a memory limit. Keep Prometheus, Loki and Grafana retention short.

## Completion plan and where we stopped (P2, 14.11.2026, 19:52)

Goal: close every open item above (P1, P2, P3), in this order. Everything below is on `main` unless marked otherwise.

**Done today**
- P1: double `sudo make up` (idempotent), `make storage-isolation-check` 30/30, live chaos run (S3 stopped through the demo API: fallback to `db`, alerts fired and cleared, 0 readings lost), netem on the real backend pod, k8s re-review, RAM limits (frontend raised to 256Mi), metric names confirmed.
- P2: backend + simulator deployed on the VPS through `make up`, checked over HTTPS (login, uploads per category with matching SHA-256, masked personal data, traces, meter readings 0 lost), demo rehearsal (storm, S3 down, corruption). Fixed on the VPS: `/metrics` Content-Type, so Prometheus scrapes the backend and `MeterReadingsLost` is quiet.
- Cleanup: the Python adapters were removed (TypeScript port in `backend/src/storage/`), and old images and logs were removed from the VPS. Every test credential is now generated at random; no secret is in git.

**Stopped here (14.11.2026 20:00).** The work was stopped on request. Everything finished is merged into `main` and pushed. The unfinished work is pushed as branches to `origin` (the `StefanCondorache/file-grid-ppc` fork).
- Merged in `main`:
  - Backend branch `feat/p2-backend-endpoints`, 11 commits, all green (199 backend tests, typecheck and lint clean):
    - `GET /auth/me` and background polling no longer extend the session;
    - fixes for the 3 known limits and the FTP health login;
    - SSE `GET /api/v1/stream`, cross-replica through Postgres LISTEN/NOTIFY;
    - `GET /audit-events`;
    - `GET /guarantees` and `GET /alerts` (+ `POST /alerts/{id}/acknowledge`, migration `0002_guarantees_alerts`);
    - `GET /metrics/matrix`, bulkhead series in `GET /metrics/bulkhead`;
    - `Range` downloads.
  - New env vars, all with defaults: `STREAM_PING_S` (20), `STREAM_COUNTERS_INTERVAL_S` (2), `STREAM_MAX_CLIENTS` (200), `GUARANTEE_EVAL_INTERVAL_S` (15), `GUARANTEE_WINDOW_MINUTES` (60), `GUARANTEE_AT_RISK_RATIO` (0.8), `GUARANTEE_METER_LOST_MAX` (0), `GUARANTEE_CONNECTION_ENCRYPTED_PCT` (100), `GUARANTEE_CONNECTION_UNMASK_MAX` (20), `GUARANTEE_DRONE_SUCCESS_MIN` (0.95), `GUARANTEE_DRONE_SUCCESS_AT_RISK` (0.99).
  - Frontend slice 6b, tasks 6b.1-6b.8 (8 commits, up to `fab434a`): state machine, backoff, chunk plan and policy pre-validation, SHA-256 in a worker, IndexedDB store with the PII allow-list, network monitor, the upload API port on the **real** contract (`frontend/src/mocks/handlers/uploads.ts` follows `docs/api.md`), and the parallel part scheduler. Typecheck and lint are clean and 243 unit tests pass. These are libraries; no screen uses them yet.
- Not merged (branch `feat/frontend-6b-upload` on `origin`, last commit `5fa4926` "wip:"): 6b.9 engine facade, progress and store. The unit tests pass (264), but `tsc` fails at `frontend/src/lib/upload/engine.ts:435` (`UploadMetadata` is not assignable to `Readonly<Record<string, unknown>>` when the metadata is persisted).
- Not deployed: the VPS still runs backend `68972a4` and simulator `91a34b9`. The merged backend needs a redeploy; migration `0002` runs by itself when the container starts.
- Branch `p2/demo-fixes` (verification fixes, not merged or deployed yet): S2 period ids stable while a storm runs; boot waits up to 90 s for the database (`/readyz` 503 `starting`) and migrates in-process; SIGTERM drains requests before the DB pool closes; `X-Forwarded-For` trusted only from `TRUSTED_PROXY_CIDRS` (audit records `clientIp`, migration `0003`); gauge `filegrid_meter_readings_lost`; failure counters exported at 0; `nosniff`/`no-referrer`/`no-store` headers; simulator logs `trace_id`.

**Next, in order**
1. Backend leftovers:
   - write `docs/api.md` sections for `/metrics/matrix`, the bulkhead series, `Range`, the `/stream` payloads and the session rule for background GETs (`/stream` event names, `/audit-events`, `/guarantees` and `/alerts` are documented since branch `p2/demo-fixes`);
   - add `/api/docs-json` (a static OpenAPI document of the real API, plus a test that every Nest route is in it);
   - redeploy the backend on the VPS (backend image only: `docker build -t filegrid-backend:<sha> backend`, import it into k3s, then `BACKEND_TAG=<sha> SIMULATOR_TAG=91a34b9 FRONTEND_TAG=none ./scripts/k8s-app-up.sh`).
2. Finish 6b on `feat/frontend-6b-upload`: fix the type error in 6b.9, then 6b.10 (resume after reload), 6b.11 (upload screen with the chunk grid), 6b.12 (tray and announcements) and 6b.13 (slice e2e). Merge it into `main`.
3. P3 5.15: build the frontend image off-VPS (Docker now runs locally), `docker save | k3s ctr images import` on the VPS, roll out with `make app-up` (it skips nothing that has an image). Check `/healthz`, the login page on `/`, the CSP, and `kubectl top`.
4. P3 slices 6c, 6d and 6f, two at a time, each wired to the real API.
5. P3 6e (guarantees, health strip, alerts, matrix, bulkhead chart; the backend endpoints exist now), then 6g (demo control room, live meter view); 6e must merge before 6g.
6. P3 6h: audit log (`GET /audit-events` exists), cross-slice integration test, accessibility pass, demo rehearsal on the VPS, backup video (Playwright recording).
7. Final pass: `make up` on the VPS, a full rehearsal of the demo beats, then tick everything here.

**Left undone on purpose**
- P1: alert webhook (Discord or Telegram). The main dev will do it; the URL goes only into the `monitoring/alertmanager-config` Secret.

**How to resume:** `git fetch origin`; the unfinished branch is `origin/feat/frontend-6b-upload`. The VPS runs backend `68972a4` and simulator `91a34b9` (`kubectl -n filegrid get pods`), and `/` still serves the placeholder.

## Stare după preluare (14.11.2026, seara) — branch `feat/handoff`, deployat pe VPS

Tot ce urmează e în `feat/handoff` (pe GitHub) și rulează pe https://ppc.filegrid.cc.cd. Ghidul de lucru în paralel (reguli de branch-uri și PR-uri) a fost trimis separat.

**Făcut și deployat**
- Login **fără parolă** (temporar, pentru demo): alegi rolul și intri. Comutatorul e `FILEGRID_PASSWORDLESS_LOGIN` în `deploy/k8s/app/backend/deployment.yaml`; pune `"false"` și redeploy după demo (oricine poate intra și ca admin cât e pornit).
- 6b upload: motorul (6b.9), reluare după reload (6b.10), ecranul cu grila de bucăți (6b.11), tava de încărcări (6b.12).
- 6c fișiere: tabel și filtre, avarii live, citiri contoare, detaliu fișier, trasare, lanțul de custodie, **descărcare cu verificare SHA-256** (6c.8), dezvăluire date personale doar pentru auditor (6c.9).
- 6d politici: listă, editare cu diff și confirmare, conflict 409.
- 6e garanții de business, banda de sănătate storage, alerte, matricea categorie × storage, graficul bulkhead, pauza „Actualizări live”.
- 6f statistici S1/S2/S3 cu interpretări (inclusiv harta și anomaliile).
- 6g camera de control demo (`/demo`, doar admin): furtună ×10, ritm normal/vârf, oprire/pornire S3 și FTP, corupere fișier, resetare; contoare live (`/meters`).
- 6h.1 jurnalul de audit (`/audit`).
- Infra/backend (V1/V2): HSTS și headere de securitate, Grafana securizat, parolă separată pentru conturile demo, IP-ul real al clientului (Traefik nu mai crede `X-Forwarded-For`), alertă „citiri pierdute” corectă (gauge `filegrid_meter_readings_lost`), alerte de infrastructură, `make up` idempotent fără placeholder, oprire grațioasă (0 erori 5xx la rollout), perioada S2 curentă, retry la pornire.
- Verificat live: furtuna ×10 (100 citiri/s, ~5 min) cu 0 citiri pierdute, 0 erori 5xx, nicio alertă falsă; a doua rulare `make up` nu repornește nimic.

**Rămas de făcut**
- [ ] Testare manuală în browser a ecranelor noi (s-au construit în mod rapid, fără review per task): upload, fișiere + detaliu + descărcare, politici, audit, `/demo`, `/meters`, `/observability`, statistici.
- [ ] Revizia finală pe tot branch-ul (nu s-a făcut din lipsă de timp) și PR-ul `feat/handoff` → `main`.
- [ ] Teste Playwright e2e nescrise: 6b.13, 6c.10, 6d.4, 6e.7, 6f.6 (început, necomis), 6g.4; apoi 6h.0 (integrare) și 6h.2–6h.6.
- [ ] 6c.8 parțial: lipsesc „verifică fără a salva” și salvarea în flux pentru fișiere > 64 MiB (acum le verifică serverul); „Restaurează din rezervă” se bazează pe câmpul `fallbackAvailable`, care nu e în `docs/api.md`.
- [ ] Furtuna din `/demo` e doar pe citiri de contor: backend-ul acceptă doar `meter_readings` la `POST /demo/storms`.
- [ ] La 100 citiri/s backend-ul stă la ~39% CPU, deci HPA nu scalează în demo; pentru momentul „scalare” trebuie o furtună mai mare sau un prag mai mic.
- [ ] Sarcini libere din ghid: dovada 1 GB pe backend-ul NestJS, pași de criptare/audit în trasări + trasări filtrate pe rol, webhook pentru alerte, scriptul demo-ului și slide-urile, testul pe o mașină curată. Pregătite dar nepornite: documentația API + `/api/v1/docs-json` (`p2/api-docs`) și seed-ul de date demo (`p2/demo-seed`).
- [ ] Criptarea Secret-urilor k3s: `make k3s-secrets-encrypt` e gata, dar repornește k3s (1–2 min), deci se rulează doar cu acordul echipei.
- [ ] Minore: logout fără revocare pe server, CSP cu `unsafe-inline`, worker-ul MSW în imaginea de producție, prima operație FTP lentă (~2 s), `filegrid_storage_errors_total` neinițializat, `make up` afișează `configured` la ValidatingAdmissionPolicy deși nu se schimbă.
