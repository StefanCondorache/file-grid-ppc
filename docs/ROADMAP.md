# FileGrid PPC: learning and presentation roadmap

A study and presentation guide for the team, written against `main` at `6eb8e0c` (15.11.2026). Read it in
order: what to say, how it works, where to show it, what the jury may ask.

---

## 1. The pitch (30 seconds)

> **RO:** Rețele Electrice primește zilnic citiri de contoare, fișe de avarie, documente de racordare și
> video de la drone, puse azi ad-hoc pe FTP, S3 sau în baze de date. FileGrid este **o singură poartă de
> intrare**: o **politică per categorie** decide unde și cum se scrie fiecare fișier, iar sistemul
> **dovedește** că fișierul recuperat e identic (SHA-256), **rezistă** la căderea unui storage și la rețele
> proaste și **măsoară** tot, ca să spună din date ce storage se potrivește fiecărei categorii.
>
> **EN:** One entry point for the grid's field files. A per-category policy picks the storage (S3, FTP or
> PostgreSQL). Every file is proven identical with SHA-256. The system survives storage outages and bad
> networks, and it measures everything, so the data says which storage fits which category.

Live: **https://ppc.filegrid.cc.cd** (demo mode: pick a role, no password).

---

## 2. The problem in one table (brief, table 2.1)

| Category | Arrives | Size | Business guarantee | How we prove it |
|---|---|---|---|---|
| **Citiri contoare** (meter readings) | pushed by simulated smart meters | 1–50 KB, very many | none lost, none duplicated | idempotent on `readingId`; live counters: received, unique, duplicates rejected, **lost = 0** |
| **Înregistrări de avarie** (fault records) | UI upload | 1–10 MB, peaks in storms | available to dispatch **immediately** | "available after X s" on every upload; a bulkhead keeps it fast during a storm |
| **Documente de racordare** (connection documents, personal data) | UI upload | 0.1–10 MB | personal data **protected and auditable** | encrypted at rest (AES-256-GCM); name and CNP masked; only the auditor can reveal them, with a reason, and the reveal is audited |
| **Video inspecție dronă** (drone videos) | UI upload | 100 MB – 1 GB+ | transfer **survives slow or unstable networks** | resumable upload in parts, retries with backoff, resume after going offline or a reload; server memory stays flat for 1 GB+ |

---

## 3. Architecture (draw this on a slide)

```
 Browser (Next.js UI)                         Smart meters (simulator)
      │ HTTPS: Cloudflare → Traefik (Let's Encrypt)         │ POST /api/v1/meter-readings (X-API-Key)
      ▼                                                      ▼
 ┌──────────────────────────── k3s on one VPS ─────────────────────────────────┐
 │ namespace filegrid:   frontend (Next.js) · backend (NestJS, 1–3 replicas,   │
 │                       HPA) · simulator                                       │
 │ namespace filegrid-storage (ClusterIP only, NetworkPolicy: only backend pods)│
 │                       PostgreSQL 17 · S3 (SeaweedFS) · FTP (pure-ftpd)       │
 │ namespace monitoring: Prometheus · Alertmanager · Grafana · Loki · Alloy     │
 └──────────────────────────────────────────────────────────────────────────────┘
```

| Part | Tech | Owner | Where |
|---|---|---|---|
| Cluster, TLS, storages, isolation, observability, alerts, deploy | k3s, Traefik, cert-manager, SeaweedFS, pure-ftpd, Postgres 17, Prometheus/Grafana/Loki/Alloy, Helm | P1 Gabi | `deploy/`, `scripts/`, `mk/`, `Makefile`, `README.md` |
| Backend API | NestJS 12, TypeScript, Kysely + pg, Zod 4, pino, prom-client | P2 (you) | `backend/src/` |
| Storage adapters, encryption | TypeScript port of P1's design: S3 (SigV4), FTP, DB; FGE1 AES-256-GCM | P1 design, P2 port | `backend/src/storage/`, `backend/src/crypto/` |
| Meter simulator | TypeScript with no dependencies (Node 26) | P2 | `simulator/` |
| Frontend | Next.js 16 App Router, React, TanStack Query, openapi-fetch, MSW mocks, Tailwind 4, Radix | P3 Mihail (+ Gabi) | `frontend/` |
| Contract | REST under `/api/v1`; OpenAPI document at `/api/v1/docs-json` | P2 | `docs/api.md`, `backend/src/docs/openapi.json` |

**One command:** `sudo make up` on a clean Ubuntu. It bootstraps k3s, TLS, the storages and observability,
builds and deploys the app, and generates every secret. Running it a second time changes nothing.

---

## 4. The life of a file (learn this flow; it answers half the questions)

1. **Policy.** The UI reads `GET /policies`; the backend reads the policy live from Postgres for every
   operation (`backend/src/policies/`). Defaults:

   | Category | Primary → fallback | Encrypted | Part size | Max size |
   |---|---|---|---|---|
   | meter_readings | db → s3 | no | 1 MiB | 16 MiB |
   | fault_records | s3 → db | no | 5 MiB | 512 MiB |
   | connection_documents | s3 → db | **yes (forced)** | 5 MiB | 50 MiB |
   | drone_videos | ftp → s3 | no | 16 MiB | 4 GiB |

2. **Create.** `POST /uploads` with an Idempotency-Key and Zod-validated metadata. For connection documents
   the name and CNP are sealed with the key-encryption key (KEK); only masked values are kept.
3. **Parts.** The browser hashes the file (SHA-256) in a Web Worker, cuts it with `Blob.slice` and sends
   `PUT /uploads/{id}/parts/{n}` with `X-Part-SHA256`, several in parallel. Each part streams straight into
   the policy's storage as `staging/{uploadId}/{n}`. Nothing is buffered whole, and nothing passes through
   Next.js.
4. **Complete.** `POST /uploads/{id}/complete` carries the client's SHA-256. The server re-reads the staged
   parts in order, hashes them, encrypts if the policy says so and writes the final object (to the fallback
   if the primary is down). It confirms only if both hashes match (`verdict: match`). For big files it
   answers `202` and the client polls.
5. **Download.** `GET /files/{id}/content` recomputes the SHA-256 while reading. A small file is checked
   before the first byte is sent (`409 FILE_CORRUPT`); for a big one the connection is cut if the hash turns
   out wrong. Either way the file is then marked corrupt.
6. **Trace.** Every response carries `X-Trace-Id`. `GET /traces/{id}` shows `api → policy → encryption →
   storage.put → audit → confirm`, with durations.
7. **Audit.** Every upload, download, verification, reveal of personal data and policy change is recorded
   (`GET /audit-events`).
8. **Clean-up.** An abandoned upload expires after 24 h, and a sweep then drops its staged parts.

Code for this flow: `backend/src/uploads/uploads.service.ts`, `upload-assembler.ts`,
`backend/src/object-store/object-store.service.ts`, `backend/src/files/download.service.ts`,
`frontend/src/lib/upload/` (engine, scheduler, SHA-256 worker).

---

## 5. Requirements → proof → where to show it

### Functional (§3; without these the project is not evaluated)
| ID | Requirement | Proof | Show |
|---|---|---|---|
| F1 | store and retrieve all 4 categories | upload 3 from the UI; readings come from the simulator; download all | Încărcare, Fișiere |
| F2 | FTP, S3 and DB really used, as separate services | "Stocat pe …" on every file; storage health strip; 3 StatefulSets | file detail, home |
| F3 | policy configurable without code changes | edit → diff → save → the next upload follows it (version vN) | Politici |
| F4 | retrieved file identical, provably | client hash = server hash at upload; re-checked on download; corruption detected | file detail, Cameră de control |
| F5 | one command on a clean machine | `sudo make up`, idempotent | README |
| F6 | UI to upload, search and download | filters, search, download with verification | Fișiere |
| F7 | simulator with configurable volume | normal, peak ×10, custom, stopped | Contoare live, Cameră de control |
| F8 | all code in the repo | `backend/ frontend/ simulator/ deploy/ scripts/` | GitHub |

### Non-functional (§4: how is our choice, but it must be shown live)
| ID | Requirement | How | Show |
|---|---|---|---|
| N1 | a 10× peak in one category doesn't slow the others | per-category bulkhead (`maxConcurrency`); only that category gets 503 `CATEGORY_BUSY` | Observabilitate during the storm |
| N2 | scale by adding instances, no code change | stateless backend (state in Postgres and the storages), HPA 1–3 replicas | `kubectl get hpa` (narrated) |
| N3 | files over 1 GB without memory growing with size | streaming end to end; **measured: 1,126 MiB, node RSS +29 MiB at most** | TASKS.md, "1 GB proof" |
| N4 | metrics per category × storage | Prometheus metrics, `GET /metrics/matrix` (p50/p95/p99, throughput, errors) | Observabilitate, Grafana |
| N5 | one operation traced end to end | trace id on every response, one span per step, Loki logs by `trace_id` | trace page |
| N6 | team alerted when a guarantee is at risk | guarantee evaluator + Prometheus alerts (`MeterReadingsLost`, `FaultUploadsSlow`, `FileGridStorageDown`, `VideoTransfersFailing`…) | home (alerts), Alertmanager |
| N7 | storages unreachable from outside | ClusterIP only + NetworkPolicy; `make storage-isolation-check` 30/30; no storage URL in any response | isolation check (narrated) |
| N8 | encrypted traffic, authenticated access | HTTPS + HSTS, `__Host-` session cookie, CSRF header, 5 roles | login |
| N9 | stolen storage doesn't expose personal data | FGE1 envelope (a key per object, wrapped by the KEK); PII sealed in the DB and masked in the UI | connection document detail |
| N10 | no secret in the repo | secrets generated by `make up` into k3s Secrets; only `.env.example` in git | repo |
| N11 | a storage outage stops nothing else | policy fallback + circuit breaker + health monitor | Cameră de control: Oprește S3 |
| N12 | bad network: transfers finish or resume alone | parts, retries with backoff, resume after offline or reload (IndexedDB) | DevTools offline during an upload |
| N13 | no duplicate readings; corruption detected | `readingId` dedup (retries counted, never stored twice); hash on every read | Contoare live; Corupe fișier |

### Statistics (§5): every chart has a Romanian interpretation and a recommendation
| ID | Question | Where |
|---|---|---|
| S1 | which storage fits each category, and why | Statistici → "Ce storage se potrivește…" (real latencies and sizes from the operations log) |
| S2 | peak day vs normal day | Statistici → "Zi normală vs. zi de vârf" (storm periods are recorded) |
| S3 | what the data says about the grid | Statistici → faults by zone and meter anomalies (zero, or over 5× the zone mean); **Hartă live** (`/map`): the 3 areas coloured by this hour's consumption, outages, anomalous meters, live readings |

---

## 6. The mechanisms, in one breath each

- **Policy engine:** one row per category, with a version. A save must send the current `baseVersion`, or it
  gets `409` because someone else saved first. Every version and its diff is kept and audited.
- **Resumable upload:** no upload lives in server memory. Parts are staged in storage and the session lives in
  Postgres, so any replica can take the next part and a reload resumes from the last confirmed part.
- **Three hashes:** one per part (`X-Part-SHA256`), one for the whole file at completion (client vs server),
  and one again on every download or verification.
- **Encryption (FGE1):** a fresh data key per object, AES-256-GCM in 64 KiB segments, the data key wrapped by
  the KEK (`FILEGRID_KEK`). Connection documents can't be stored unencrypted.
- **Fallback + circuit breaker:** if the primary fails or is known to be down, the write goes to the policy's
  fallback. The breaker stops calling a dead storage and half-opens to test whether it is back.
- **Bulkhead:** each category has its own concurrency budget, so a storm of fault uploads can't starve the
  drone or connection uploads.
- **Meter dedup:** readings arrive in batches and each `readingId` is stored once; a retried reading is
  acknowledged as a duplicate. `lost = sent − acked − queued`, reported by the simulator, must stay 0.
- **Guarantees:** every 15 s the leader replica evaluates the 4 guarantees (ok, at risk, violated) and
  records each change as an alert. The UI shows them live over Server-Sent Events (`GET /stream`).
- **Roles:** teren, dispecerat, racordări, auditor, admin (a capability matrix). Only the **auditor** can
  reveal personal data: for 60 s, with a reason, audited. The admin can't; that separation is deliberate.

---

## 7. Numbers to quote

| Fact | Value |
|---|---|
| 1 GB proof (VPS) | 1,126 MiB in 71 parts of 16 MiB: upload 15.9 s, verify and store 22.4 s, download 14.5 s, SHA-256 match, **+29 MiB node RSS at most** (budget +64 MiB) |
| Meter readings, storm on the VPS | ×10 (about 100 readings/s, ~5 min): 0 lost, 0 duplicates stored, 0 server errors |
| Storage isolation check | 30/30 |
| Automated tests | backend 286 (embedded Postgres, real S3/FTP protocol tests), simulator 88, frontend unit tests (vitest) |
| Footprint | designed for a 4 GB, 2-core VPS; every container has memory limits (backend 384 Mi) |

---

## 8. The 7-minute demo (full table with fallbacks: `docs/frontend/demo-script.md`)

1. **0:00** Log in as admin → Garanții de business: 4 cards, storage health strip, live meter counter.
2. **0:30** Echipă de teren: upload a drone video; DevTools offline → online → F5; it resumes; SHA-256 verified.
3. **1:45** Dispecerat: upload a fault record; it's available in seconds and appears live in Fișiere.
4. **2:30** Angajat racordări: upload a connection document (masked). Auditor: reveal it with a reason → it's in
   the Jurnal de audit.
5. **3:15** Admin, Cameră de control: start a storm ×10, stop S3 → the other categories stay flat, uploads go to
   the fallback, an alert fires; start S3 again → recovery.
6. **4:30** Corrupt a file → "Corupție detectată"; open a trace (api → policy → storage → audit).
7. **5:30** Policy live: fault records S3 → FTP; the next upload says "Stocat pe FTP · politica vN".
8. **6:00** Statistici (S1, S2, S3) and the Hartă live.

Before the demo: `npm run seed:demo` (in `backend/`) after the final deploy, and the simulator at normal.
After the demo: Resetează demo-ul, set fault records back to S3, and turn passwordless login off.

---

## 9. Questions the jury may ask

- **Why three storages instead of one?** The brief requires FTP, S3 and DB to be really used. We let the data
  decide: S1 compares latency and fit per category and recommends one.
- **What if S3 dies during the demo?** The policy's fallback takes the writes, the breaker isolates S3 and an
  alert fires. A confirmed file is never lost, because a file is confirmed only after a durable write with a
  matching hash.
- **How do you prove the file is the same?** The browser and the server each compute the SHA-256 at upload,
  and the server recomputes it on every download. One flipped byte is detected, and we show it live.
- **A 1 GB file on a small server?** Nothing is ever held whole. The browser slices the file, and the server
  streams the parts to storage and streams them again at completion. Measured: +29 MiB for 1.1 GiB.
- **How do you scale?** The backend keeps no state of its own (it's in Postgres and the storages), so the HPA
  adds replicas, and the bulkhead keeps one category's peak from hurting the others.
- **Who sees personal data?** Nobody, by default: it's masked everywhere and encrypted at rest. Only the auditor
  can reveal it, with a reason, for 60 s, and the reveal is audited.
- **Can someone reach a storage from the internet?** No: ClusterIP only, plus a NetworkPolicy that blocks
  everything except the backend. The API never returns a storage URL, bucket or path.
- **Duplicate readings when a meter retries?** `readingId` is the idempotency key. The retry is acknowledged as
  a duplicate and never stored twice, and the counters show it.
- **How do you know a guarantee is at risk?** It's evaluated every 15 s from real metrics, and the alerts appear
  in Alertmanager and on the home screen.
- **Why NestJS, Next.js and k3s?** §6 of the brief only recommends a stack. Ours is TypeScript end to end (one
  language for the team), and k3s gives replicas, isolation and a one-command deploy on one VPS.

---

## 10. Learning path (about 2 hours, in this order)

1. `docs/brief/FileGrid_PPC.pdf`, §2–§5: the requirements. 15 min
2. `README.md`: architecture, `make up`, storage isolation, the contracts for P2/P3. 15 min
3. `docs/api.md`: auth, policies, resumable upload, files, meters, traces, stream, the demo endpoints. 25 min
4. The backend flow: `uploads.service.ts` → `upload-assembler.ts` → `object-store.service.ts` →
   `download.service.ts`; then `policies/`, `meters/meters.service.ts`, `guarantees/`. 30 min
5. The frontend: `frontend/src/lib/upload/` (engine, worker), `features/upload`, `features/files`,
   `features/demo`, `features/map`. 20 min
6. `TASKS.md`: "P2 status", "P2 parallel tasks" (with the 1 GB proof) and "State on 15.11" (done and left). 10 min
7. Click through the demo once on the live site, or on the mocks: `cd frontend && npm run dev`. 15 min

---

## 11. Team

- **P1 Gabi:** the k3s platform, TLS, storages and isolation, observability and alerts, chaos scripts, deploy,
  security hardening, the live map; final deploys and merges.
- **P2 (you):** the NestJS backend (policies, resumable upload, integrity, the encryption port, meters, traces,
  audit, guarantees and alerts, statistics, demo endpoints, `docs-json`), the simulator, the 1 GB proof, the
  demo seed data.
- **P3 Mihail:** the Next.js frontend (shell, upload engine, files, policies, audit, monitoring, statistics,
  control room), the design system and the frontend clean-up.

---

## 12. Honest limits (say them before someone finds them)

- Storms are simulated for meter readings only.
- At 100 readings/s the backend uses about 39% CPU, so the HPA doesn't scale during the demo; scaling is
  narrated.
- k3s Secret encryption at rest is prepared (`make k3s-secrets-encrypt`) but not enabled, because it restarts k3s.
- Alerts don't reach a chat yet (no Discord/Telegram webhook); they're visible in the UI and in Alertmanager.
- Passwordless login is for the demo only; turn it off afterwards.
- The Playwright end-to-end tests were removed in the frontend clean-up (PR #12), and there's no backup video
  of the demo yet. The rehearsal commands at the end of `docs/frontend/demo-script.md` refer to that removed
  spec.

---

## 13. Command cheat sheet

```
# deploy and status (on the VPS)
sudo make up                 # everything, idempotent
make status                  # pods, certificate, URLs
make storage-isolation-check # the storages are unreachable from outside

# demo data and proofs (in backend/)
FILEGRID_URL=https://ppc.filegrid.cc.cd npm run seed:demo
node scripts/proof-1gb-upload.ts                     # the 1 GB proof (see TASKS.md)

# local development
cd backend && npm ci && npm test                     # 286 tests, embedded Postgres
cd simulator && node --test test/                    # 88 tests
cd frontend && npm ci && npm run dev                 # the UI on mocks at :3000
cd frontend && npm test                              # unit tests (vitest)
```
