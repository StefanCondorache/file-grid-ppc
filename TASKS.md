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
