# FileGrid PPC: Team Task Split

Source of requirements: `docs/brief/FileGrid_PPC.pdf`.

Stack:
- **Backend:** Python FastAPI.
- **Frontend:** React + Vite.
- **Storage (already in `infra/`):** PostgreSQL, SeaweedFS (S3) and pure-ftpd (FTP).
- **Observability:** Prometheus, Grafana and Loki.
- **VPS:** k3s with Traefik and cert-manager on `ppc.filegrid.cc.cd`.

Already done: storage services (`make infra-up`) and the k3s TLS placeholder site.

## Ownership

Only edit your own folders. If you need a change in someone else's folder, ask them.

| Person | Role | Owns |
|---|---|---|
| **P1** | Infra, storage, security | `infra/`, `deploy/`, `Makefile`, `README.md`, `backend/app/storage/`, `backend/app/crypto/` |
| **P2** | Backend API, data, simulator | `backend/` (except `storage/` and `crypto/`), `simulator/`, `docs/api.md` |
| **P3** | Frontend | `frontend/` |

Each person writes the Dockerfile for their own part. P1 wires the Dockerfiles into compose and k8s.

**Contracts to agree in the first hour.** After that, change them only after telling the others:
- `backend/app/storage/base.py` (P1 writes it, P2 uses it). It defines the storage adapter interface: `put_stream(key, chunks) -> (size, sha256)`, `get_stream(key)`, `delete(key)` and `health()`.
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

### Stare P1 (14.11.2026, 13:50)

Codul P1 e pe `main`. Contractele de integrare sunt în README, secțiunea „Contracte pentru P2/P3”.

| # | Stare |
|---|---|
| 1 | ✅ Adaptoare async S3/FTP/DB (memorie constantă, SHA-256) în `backend/app/storage/`; 164 de teste unitare trec |
| 2 | ✅ Criptare AES-256-GCM pe stream în `backend/app/crypto/` (cheia din Secret-ul `filegrid-app-secrets`) |
| 3 | ✅ Circuit breaker, health monitor și metrici per storage |
| 4 | ✅ `sudo make up` pornește k3s, HTTPS, storage, observabilitatea și aplicația (pentru fiecare folder cu `Dockerfile`) |
| 5 | ✅ Prometheus, Grafana la `/grafana` (dashboard `filegrid-overview`; parola cu `make grafana-password`), Loki + Alloy |
| 6 | ✅ 7 reguli de alertă; fără webhook (notificările se activează din Secret-ul `monitoring/alertmanager-config`) |
| 7 | ✅ Storage doar ClusterIP + NetworkPolicy (`make storage-isolation-check`); manifestele aplicației sunt în `deploy/k8s/app/` |
| 8 | ✅ `make chaos-storage-stop/start S=…`, `make chaos-netem-on/off` (doar în rețeaua podului), RBAC pentru panoul demo |

**Rămas de făcut (oricine din echipă):**
- [ ] Rulați `sudo make up` de două ori pe VPS după merge: a doua rulare nu trebuie să schimbe nimic. Apoi `make storage-isolation-check`.
- [ ] Repetiție de chaos live: `make chaos-storage-stop S=s3`; categoriile pe FTP/DB trebuie să meargă în continuare; apoi `make chaos-storage-start S=s3`. Netem a fost testat doar pe un pod de unică folosință.
- [ ] Testele de integrare ale adaptoarelor, în cluster: `backend/app/storage/tests/run-in-cluster.sh`. Ultimele commit-uri pe storage (FTP keep-alive, curățenie de teste) nu au mai avut review independent.
- [ ] Ultimul re-review pentru fix-urile k8s (pin k3s/Helm, timeout Traefik, ordinea storage → TLS în `make up`) a fost oprit înainte de final: o trecere rapidă prin `git show fd79ace eb23ac0`.
- [ ] RAM: rămân ~0,9 GiB liberi cu observabilitatea pornită. Puneți `resources.limits` pe backend/frontend/simulator (sunt deja în `deploy/k8s/app/`) și urmăriți `kubectl top pods -A`.
- [ ] P2: confirmați numele metricilor și valorile `outcome` din README (alertele și dashboard-ul depind de ele) și faptul că `filegrid_sim_readings_sent_total` numără citiri unice.
- [ ] Opțional: webhook Discord/Telegram pentru alerte (vezi comentariul din `deploy/k8s/observability/prometheus-values.yaml`).

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
- [ ] Build the `backend/` and `simulator/` images and run `make app-up` on the VPS. Check `/readyz`, a login and an upload over HTTPS.
- [ ] Demo rehearsal: storm, stop S3 (fault records must move to the `db` fallback), corrupt a file then download it.
- [ ] P3: switch the mocks to the real API. Category ids are P1's (`fault_records`, `s3`…); see "Differences from the frontend proposal" in `docs/api.md`.
- [ ] Optional: `GET /api/v1/stream` (SSE), `/api/docs-json` (Swagger), `/audit-events`, `/guarantees`, `/alerts`, downloads with `Range`.

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

## Milestones

1. **M1:** adapters, upload/download API, and the UI shell on mocks.
2. **M2:** all 4 categories work end to end from the UI, with hashes verified.
3. **M3:** non-functional requirements: bulkhead, resume, encryption, failover, dashboards, alerts.
4. **M4:** statistics and the demo panel, a one-command start on a clean machine, and a demo rehearsal.

The VPS has 4 GB RAM and 2 cores, so every container needs a memory limit. Keep Prometheus, Loki and Grafana retention short.
