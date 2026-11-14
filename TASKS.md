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
- [x] Rulați `sudo make up` de două ori pe VPS după merge: a doua rulare nu trebuie să schimbe nimic. Apoi `make storage-isolation-check`. **Făcut 14.11:** a doua rulare nu a repornit nimic (aceleași poduri, 0 restarturi); singura linie `configured` e `ValidatingAdmissionPolicy` `filegrid-demo-storage-scale-0-or-1`, cosmetică (`kubectl diff` gol). Izolare: **30/30**.
- [x] Repetiție de chaos live: `make chaos-storage-stop S=s3`; categoriile pe FTP/DB trebuie să meargă în continuare; apoi `make chaos-storage-start S=s3`. Netem a fost testat doar pe un pod de unică folosință. **Făcut 14.11** (prin API-ul demo, același ca panoul): cu S3 oprit, fault records au mers pe fallback `db`, video pe FTP și contoarele pe DB au continuat (0 pierdute); `FileGridStorageDown(s3)` + `FileGridCircuitOpen(s3)` au pornit în ~1,5 min și s-au stins după repornire. Netem pe podul backend real (300 ms ± 50 ms, 5% pierderi): API ~0,35 s în loc de 0,04 s, backend gata; `chaos-netem-off` a curățat complet.
- [x] ~~Testele de integrare ale adaptoarelor, în cluster: `backend/app/storage/tests/run-in-cluster.sh`.~~ Înlocuit: adaptoarele Python au fost portate în TypeScript (`backend/src/storage/`) și verificate pe storage-urile din cluster (vezi „P2 status”). Fix-ul FTP keep-alive (b66395d) e inclus în portare; review independent făcut pe codul TypeScript.
- [x] Ultimul re-review pentru fix-urile k8s (pin k3s/Helm, timeout Traefik, ordinea storage → TLS în `make up`) a fost oprit înainte de final: o trecere rapidă prin `git show fd79ace eb23ac0`. **Făcut 14.11:** corecte; `readTimeout` 900 s acoperă părțile de upload (16 MiB la 1 Mbit/s ≈ 2-3 min).
- [x] RAM: rămân ~0,9 GiB liberi cu observabilitatea pornită. Puneți `resources.limits` pe backend/frontend/simulator (sunt deja în `deploy/k8s/app/`) și urmăriți `kubectl top pods -A`. **Făcut 14.11:** limite backend 384Mi (heap V8 192 MB), simulator 128Mi, frontend ridicat la 256Mi (cererea P3). Măsurat: backend ~170-180Mi, simulator ~40-50Mi, toate podurile ~1,35 GiB, ~1,2 GiB disponibili pe gazdă.
- [x] P2: confirmați numele metricilor și valorile `outcome` din README (alertele și dashboard-ul depind de ele) și faptul că `filegrid_sim_readings_sent_total` numără citiri unice. **Confirmat** (vezi „P2 status” și `docs/api.md`); Prometheus scrapează backend-ul (fix Content-Type `a96d1fa`), iar `MeterReadingsLost` arată 0.
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
- [x] Build the `backend/` and `simulator/` images and run `make app-up` on the VPS. Check `/readyz`, a login and an upload over HTTPS. **Done 14.11:** built and deployed by `sudo make up` (run twice, idempotent); over HTTPS: login (`__Host-` cookie), CSRF, one upload per category with matching SHA-256 after download, masked personal data, traces, 1,172/1,172 readings stored and 0 lost. Found and fixed on the VPS: `/metrics` was served as text/html, so Prometheus rejected the scrape (`a96d1fa`).
- [x] Demo rehearsal: storm, stop S3 (fault records must move to the `db` fallback), corrupt a file then download it. **Done 14.11** through the demo API: 10x storm, S3 stopped (fault records on the `db` fallback, FTP and DB categories unaffected, 0 readings lost, `FileGridStorageDown(s3)` fired and cleared), S3 restarted, corrupted file answered `409 FILE_CORRUPT` and was marked corrupt.
- [ ] P3: switch the mocks to the real API. Category ids are P1's (`fault_records`, `s3`…); see "Differences from the frontend proposal" in `docs/api.md`.
- [ ] Known limits from the code review (minor, left as they are):
  - S3 down: a part upload gets `503` (the client retries) instead of the fallback until the circuit opens (~10 s: 5 failures or 2 failed health probes). FTP and DB fall back at once.
  - A DB storage pool full of slow transfers (default 8 clients, `FILEGRID_PG_POOL_MAX`) is counted as an outage and can open the `db` circuit.
  - A download client that stalls for more than 30 s on a large S3 file can count as an S3 failure.
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
- [ ] `@nestjs/swagger` cu `/api/docs-json`, ca să generăm tipurile din API-ul real.
- [ ] Jurnalul operațiilor (trace, metrici), tag-ul `origin`, perioade etichetate (S2) și pragurile garanțiilor. **Parțial (P2):** jurnalul operațiilor (`/traces/{id}`), `origin` și perioadele etichetate (`/statistics/periods`) există; pragurile garanțiilor sunt în lucru.
- [ ] Confirmare: `GET /auth/me` nu prelungește sesiunea (doar `POST /auth/refresh` și activitatea reală).

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
