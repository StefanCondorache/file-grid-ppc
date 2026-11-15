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

## 5. Every requirement of the brief, explained

The brief (`docs/brief/FileGrid_PPC.pdf`, 4 pages) has 28 requirements: 4 business guarantees, 8 functional,
13 non-functional and 3 statistics questions. Each entry quotes it in Romanian, then says what it means, how
FileGrid meets it, and where to show it.

### §1–§2 · The context and what we build

- **"FileGrid este punctul de intrare pentru toate aceste date. Fișierele nu sunt preluate din alte sisteme, ci
  intră direct în aplicație."** Nobody imports old files: every file enters through our API, so every file has a
  policy, a hash, a trace and an audit entry from its first byte.
- **"Video-urile, înregistrările de avarie și documentele de racordare sunt adăugate de utilizatori (echipe de
  teren, dispecerat, angajații care procesează racordări) din interfață."** These are three of our five roles
  (teren, dispecerat, racordări). Each sees only its categories, enforced by the API, not just hidden in the UI.
- **"Citirile de contor sunt trimise automat … de contoarele inteligente, pe care trebuie să le simulați voi."**
  `simulator/` plays thousands of meters and pushes batches to `POST /api/v1/meter-readings` with an API key.
- **"FileGrid decide, pe baza unei politici per categorie de date, unde și cum se scrie fiecare fișier,
  verifică integritatea lui și măsoară tot ce se întâmplă."** That one sentence holds the whole design: the
  policy engine (where and how), the SHA-256 checks (integrity), and Prometheus, traces and statistics
  (measure everything).

### §2.1 · The four business guarantees

| Category | Guarantee (RO) | What it means | How we meet it | Show |
|---|---|---|---|---|
| Citiri contoare | "Nicio citire nu se pierde și nu se dublează (altfel facturile sunt greșite)" | every reading is stored exactly once, even when the meter retries | `readingId` is unique in the database: a retry is acknowledged as a duplicate and not stored again; `lost = sent − acked − queued` from the simulator; alerts `MeterReadingsLost`, `MeterReadingsDuplicateStored` | Contoare live: received / unique / duplicates rejected / lost 0 |
| Înregistrări de avarie | "Disponibile imediat pentru dispecerat" | a fault record is readable seconds after the upload, even in a storm | small parts, available as soon as both hashes match; every upload answers `availableAfterMs`; the bulkhead keeps other traffic from slowing it; alert `FaultUploadsSlow` | upload as dispecerat: "disponibil în X s", live in Fișiere |
| Documente de racordare | "Datele personale rămân protejate și verificabile la audit" | personal data unreadable without permission, and every access traceable | forced AES-256-GCM encryption at rest; name and CNP sealed in the DB, masked in the UI; only the auditor reveals them (reason, 60 s), and every reveal is in the audit trail | file detail (masked), reveal, Jurnal de audit |
| Video-uri inspecții dronă | "Transferul rezistă pe conexiuni lente sau instabile" | a 1 GB upload over a bad mobile link still finishes | resumable upload in 16 MiB parts, each retried with backoff (about 15–30 min before asking for a click), resume after offline or reload from IndexedDB; alert `VideoTransfersFailing` | DevTools offline → online → F5 during an upload |

### §3 · Minimum functional requirements ("Fără acestea, proiectul nu intră în evaluare")

1. **"FileGrid stochează și recuperează fișiere din toate cele patru categorii."** Upload and download work for
   all four categories (meter readings are stored in batches, one file per batch, browsable in Fișiere). Show:
   Încărcare, then Fișiere with the category filter.
2. **"Fiecare dintre cele trei tipuri de storage (FTP, S3, bază de date) este folosit efectiv și rulează ca
   serviciu separat. S3 poate fi emulat local."** Three StatefulSets in their own namespace: PostgreSQL 17,
   SeaweedFS (S3-compatible, our "local emulation"), pure-ftpd. The default policies use all three (drone videos
   on FTP, faults and documents on S3, readings in the DB). Show: "Stocat pe …" on a file, and the storage health
   strip.
3. **"Politica per categorie de date este configurabilă, fără modificarea codului."** Policies live in Postgres
   with versions; the admin edits them in Politici (primary, fallback, encryption, part size, parallelism,
   maximum size, allowed types); the next operation reads them live. Show: change faults to FTP, upload one,
   the file says "Stocat pe FTP · politica vN".
4. **"Fișierul recuperat este identic cu cel stocat, iar FileGrid poate demonstra asta."** SHA-256 in the browser
   and on the server at upload (both shown), recomputed on every download and on demand (verification). We
   also prove the opposite: the control room flips one byte and the next read detects it. Show: file detail
   hashes, Corupe fișier → "Corupție detectată".
5. **"Întregul sistem pornește pe o mașină curată cu o singură comandă, urmând README-ul."** `sudo make up`
   installs k3s, TLS, the storages, observability and the app, builds the images and generates every secret;
   running it again changes nothing. Show: the README Quickstart.
6. **"Există o interfață din care utilizatorii încarcă, caută și descarcă fișiere din categoriile încărcate
   manual."** Next.js UI: Încărcare (category, metadata, drag and drop, queue), Fișiere (search, filters by
   category, zone, interval, integrity), download with a hash check. Show: the three screens.
7. **"Există un simulator de contoare inteligente care trimite continuu citiri … cu volum configurabil, ca să
   puteți reproduce și o zi normală, și una de vârf."** Modes normal, peak (×10), custom rate and stopped, set
   from the control room or `PUT /meters/simulator`; it also sends deliberate retries and duplicates to prove
   the dedup. Show: Contoare live, Pornește furtuna.
8. **"Tot codul (aplicația, simulatorul, configurațiile și scripturile) este urcat în repository-ul Git."**
   `backend/`, `frontend/`, `simulator/`, `deploy/`, `scripts/`, `mk/`, `infra/` are all in the repo; only
   `.env.example` files, no secrets.

### §4 · Non-functional requirements ("La demo trebuie să puteți arăta live că sunt respectate")

**Scalabilitate**
- **"Un vârf de 10 ori peste volumul normal într-o singură categorie … nu degradează celelalte categorii."** Each
  category has its own bulkhead (a concurrency budget from the policy); when it is full only that category gets
  `503 CATEGORY_BUSY`. Show: storm ×10 on meter readings while the Observabilitate chart keeps the other
  categories flat. (Our storm button drives meter readings; the bulkhead works the same for any category.)
- **"Capacitatea crește prin adăugarea de instanțe, fără modificări de cod."** The backend keeps no state of its
  own (sessions, uploads and files are in Postgres and the storages), live events go between replicas through
  Postgres LISTEN/NOTIFY, and one replica is elected to evaluate the guarantees. The HPA runs 1–3 replicas on
  CPU. Show: `kubectl get hpa,pods` (narrated: at the demo load CPU stays low).
- **"Fișierele de peste 1 GB sunt procesate fără ca resursele serviciului să crească proporțional cu
  dimensiunea fișierului."** Everything streams: the browser slices, the server writes parts straight to
  storage and streams them again at completion. Measured on the VPS: 1,126 MiB, node memory +29 MiB at most.
  Show: TASKS.md, "1 GB proof".

**Observabilitate**
- **"Pentru fiecare categorie și fiecare storage se văd latența (p50, p95, p99), throughput-ul și rata de
  erori."** Prometheus metrics labelled by category, storage and operation; the 12-cell matrix
  (`GET /metrics/matrix`) and a Grafana dashboard. Show: Observabilitate.
- **"O singură operație poate fi urmărită de la cererea inițială până la storage."** A trace id on every
  response; `GET /traces/{id}`: api → policy → encryption → storage → audit, with durations; every part of an
  upload has its own trace; Loki logs searchable by `trace_id`. Show: a file's trace.
- **"Echipa este anunțată automat când o cerință de business din tabelul 2.1 e în pericol."** Every 15 s the
  backend evaluates the four guarantees (ok, at risk, violated) and records alerts; Prometheus rules
  (`MeterReadingsLost`, `FaultUploadsSlow`, `VideoTransfersFailing`, `FileGridStorageDown`…) go to Alertmanager.
  Show: the home screen during the storm or with S3 down. (A chat webhook is not connected yet.)

**Securitate**
- **"Storage-urile nu sunt accesibile direct din afara sistemului; singura cale de acces este FileGrid."**
  ClusterIP services only and a NetworkPolicy that refuses everything except the backend pods;
  `make storage-isolation-check` passes 30/30; no API answer ever contains a storage URL, bucket or path.
- **"Traficul din exterior este criptat, iar accesul la FileGrid este autentificat."** HTTPS only (Let's Encrypt
  via cert-manager, Cloudflare Full strict, HSTS); login with an `HttpOnly`, `Secure`, `SameSite=Strict` session
  cookie, a CSRF header and five roles. Passwordless login exists only in demo mode.
- **"Un acces neautorizat direct la storage nu expune datele personale din documentele de racordare."** Even with
  the raw bytes from S3 or the database, an attacker sees ciphertext: FGE1 envelope (a key per object, wrapped by
  the KEK); the name and CNP are sealed separately. Show: "criptat la stocare" on a connection document.
- **"Nicio parolă sau cheie nu se află în repository."** `make up` generates every secret into k3s Secrets; the
  repo has only `.env.example` placeholders; even the tests generate their passwords at random.

**Reziliență**
- **"Căderea unui storage nu oprește celelalte categorii și nu duce la pierderea fișierelor deja confirmate."**
  The policy's fallback takes the writes, a circuit breaker stops calling the dead storage, the other
  categories keep working. A file is "confirmed" only after a durable write with a matching hash, and the
  storages keep their data on persistent volumes, so nothing confirmed is lost. Show: Oprește S3, upload a
  fault record (it lands on the fallback), Pornește S3.
- **"Pe o conexiune cu latență mare și pierdere de pachete, transferurile se finalizează sau se reiau, fără
  intervenție manuală."** Parts with retries and backoff, resume after a disconnect or a reload; tested with
  `tc netem` (latency and loss) on the real backend pod (`make chaos-netem-on`). Show: DevTools offline.
- **"Reîncercările nu dublează citirile de contor, iar un fișier corupt este detectat la recuperare."** The same
  `readingId` is stored once (the simulator retries on purpose, the counters show the rejected duplicates). Every
  download recomputes the hash: a small corrupt file answers `409 FILE_CORRUPT`, a big one is cut off, and the
  file is marked corrupt. Show: Contoare live; Corupe fișier.

### §5 · Statistics and interpretation

The brief asks for statistics that help a decision-maker, and says the interpretation counts more than the
number of charts. Every statistic we return carries a Romanian sentence, a recommendation and the facts it is
based on.
- **"Ce tip de storage se potrivește cel mai bine fiecărei categorii de date și de ce?"** From the operations
  log: latency, throughput and errors per category and storage, with the recommended storage and why. Show:
  Statistici → "Ce storage se potrivește fiecărei categorii?".
- **"Cum s-a comportat sistemul într-o zi de vârf, comparativ cu una normală?"** Storms are recorded as periods;
  the screen compares a peak period with a normal one (volume, latency, errors, lost readings). Show: Statistici →
  "Zi normală vs. zi de vârf", right after the storm beat.
- **"Ce spun datele însele despre rețea (de exemplu, tipare sau anomalii în citirile de contor, zonele cu cele
  mai multe avarii)?"** Faults by zone, the consumption peak by hour, and anomalous meters (a zero reading, or
  over 5× the zone average). Show: Statistici → "Ce spun datele despre rețea", and the live map (section 14).

### §6 · The recommended stack

"Tehnologiile din tabel sunt recomandări … Arhitectura și designul sistemului sunt în întregime decizia
voastră." Compared with the table: **backend** NestJS instead of Spring Boot, **frontend** Next.js instead of
Angular (TypeScript end to end: one language for the whole team); **infrastructure** Docker images on k3s, a
certified Kubernetes (as recommended); **observability** Grafana, Loki and Prometheus (as recommended);
**database** PostgreSQL (one of the three options).

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

---

## 14. Our original idea: the live map of the grid ("Hartă live")

The brief asks for statistics; it doesn't ask for a map. We added one because a decision-maker at Rețele Electrice
thinks in places, not tables: where is the grid in trouble right now? The map turns §5's third question ("ce
spun datele despre rețea") into one live picture, the screen you can leave on the projector while you talk.

**What it shows** (`/map`, in the sidebar as "Hartă live"): a map of Romania by county, with the three
Rețele Electrice distribution areas (Muntenia Sud, Banat, Dobrogea) and four layers you can switch on and off:
- **Consum mediu:** each area coloured by the average consumption per reading in the current hour.
- **Avarii:** a red dot per fault record; it pulses if it was reported in the last 10 minutes.
- **Contoare anormale:** a diamond per anomalous meter (a zero reading, or a spike over 5× the zone average).
- **Citiri live:** sparks where readings arrive right now, as many as each zone's live rate; during a storm
  they multiply and a "FURTUNĂ · VÂRF ×10" badge appears.

Beside the map: total readings (unique, lost, duplicates rejected, readings per second), faults in the last
24 h, anomalies, the latest reported faults, and the "Ce spun datele" interpretation.

**How it works:** it's the same real data as the rest of the app, only drawn on a map. It reads
`GET /meters/counters`, `GET /statistics/grid-insights`, `GET /files?category=fault_records` and
`GET /meters/simulator`, and refreshes live like the other monitoring screens. The map is an SVG drawn by
us, with no map tiles and no API key, so it works offline at the venue and sends no data to a map provider.
Faults and meters carry a zone, not an exact address, so each is placed on a fixed county of its zone; the
same fault always appears in the same place. Code: `frontend/src/features/map/LiveMapScreen.tsx`.

**Why it matters for the jury:** it shows three guarantees and the grid statistics on one screen. Faults
appear on the map within seconds of the upload (available to dispatch immediately). The meter counters keep
"pierdute 0" while the storm sparks fly (none lost, none duplicated). The coloured areas and anomalies answer
"what does the data say about the grid" without reading a single chart.

**How to use it in the demo:** open it in beat 1 (live sparks, zero lost), come back during the storm in beat 5
(the badge, the sparks multiply), and end on it in beat 8 after the statistics. Upload a fault record in
Banat during beat 3, and a red dot pulses on Banat on the map.

**Limits to say out loud:** the positions are per zone, not real GPS coordinates; the consumption and
anomalies come from the simulated meters.
