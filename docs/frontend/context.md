# FileGrid PPC: frontend context (read this first)

Source of truth: [docs/brief/FileGrid_PPC.pdf](../brief/FileGrid_PPC.pdf). `TASKS.md` is only an illustrative
example: its stack, API and task split are NOT requirements. Requirement IDs below (F*, N*, S*) are ours, for
cross-referencing in later docs.

## 1. What FileGrid is

- Client: **Rețele Electrice România**, the PPC group's electricity distribution operator (Muntenia, Banat,
  Dobrogea). The jury is PPC / Rețele Electrice România.
- Today their field files land in FTP, S3 and databases chosen ad hoc; nobody can say, from data, which storage
  fits which file type. FileGrid is the **single entry point**: files are not imported from other systems, they
  enter through our app. A **per-category policy** decides where and how each file is written, FileGrid verifies
  its integrity and measures everything.
- 3 categories are uploaded by users from the UI (test files from anywhere). Meter readings are pushed
  automatically by smart meters **we simulate**.
- Users named in the brief: echipe de teren, dispecerat, angajați care procesează racordări; plus the
  decision-makers who read the statistics (§5).

## 2. Data categories and business guarantees (brief table 2.1)

| Category (EN / RO) | Arrives via | Typical size | Volume | Business guarantee (EN) | Cerința de business (RO) |
|---|---|---|---|---|---|
| Meter readings / Citiri contoare | Sent automatically by the simulated meters (no UI upload) | 1–50 KB | Very many small files, continuous | No reading is lost and none is duplicated (otherwise bills are wrong) | Nicio citire nu se pierde și nu se dublează (altfel facturile sunt greșite) |
| Fault records / Înregistrări de avarie | Uploaded from the UI | 1–10 MB | Rare normally, sudden peak during storms | Available immediately to dispatch | Disponibile imediat pentru dispecerat |
| Connection documents / Documente de racordare (requests, ID documents, permits: personal data) | Uploaded from the UI | 0.1–10 MB | Moderate | Personal data stays protected and verifiable at audit | Datele personale rămân protejate și verificabile la audit |
| Drone inspection videos / Video-uri inspecții dronă | Uploaded from the UI | 100 MB – 1 GB+ | Few, very large files, peak after storms | The transfer survives slow or unstable connections | Transferul rezistă pe conexiuni lente sau instabile |

What each guarantee means for the UI: meters → live counters (received / unique / duplicates rejected / lost = 0);
faults → time from upload to "available" is visible and short; racordări → PII masked by default, encrypted-at-rest
status, audit trail; drone videos → chunked, resumable upload with automatic retry.

## 3. Requirements the frontend must make visible or demonstrable live

Brief §4: "Cum le îndepliniți e decizia voastră. La demo trebuie să puteți arăta live că sunt respectate."

### §3 Minimum functional (gate: without these the project is not evaluated)

| ID | Requirement (EN) | What the UI must show / prove |
|---|---|---|
| F1 | Store and retrieve files from all 4 categories | Upload for the 3 manual ones; browse and download all 4, including meter readings |
| F2 | FTP, S3 and DB are each really used and run as separate services | Per file: which storage holds it and why (policy); per storage: health |
| F3 | Per-category policy is configurable without code changes | Policy screen: view and edit live; the next upload follows the new policy |
| F4 | The retrieved file is identical to the stored one, and FileGrid can prove it | SHA-256 computed client-side vs server hash at upload; re-verified on download; both hashes shown |
| F5 | Whole system starts on a clean machine with one command, following the README | The frontend must join that command (container + memory limit, `.env.example`, no manual steps) |
| F6 | A UI where users upload, search and download files of the manually uploaded categories | Upload, search/filter, download screens |
| F7 | A meter simulator sends readings continuously, configurable volume (normal day and peak day) | Live ingest rate; ideally a normal ↔ vârf rate control. Who builds the simulator: not decided |
| F8 | All code (app, simulator, configs, scripts) is in the team's Git repo before the deadline | Everything frontend lives in `frontend/` and `docs/frontend/` |

### §4 Non-functional (how is our choice; must be shown live)

| ID | Area | Requirement (EN) | What the UI must show / prove |
|---|---|---|---|
| N1 | Scalability | A 10× peak in one category (e.g. faults on a storm day) does not degrade the others | Per-category latency side by side during a storm: the others stay flat |
| N2 | Scalability | Capacity grows by adding instances, no code changes | Instance count and throughput before/after scaling (if backend exposes it) |
| N3 | Scalability | Files > 1 GB are processed without service resources growing with file size | Browser: Blob.slice chunks, hashing in a worker, constant memory. Uploads never pass through the Next.js server. Show server memory flat during a 1 GB+ upload |
| N4 | Observability | Per category × per storage: latency p50/p95/p99, throughput, error rate | Category × storage matrix |
| N5 | Observability | One operation can be traced from the initial request to storage | Trace ID per request; trace view (request → policy → storage) and a link to Grafana/Loki |
| N6 | Observability | The team is notified automatically when a table 2.1 guarantee is at risk | Alerts tied to the 4 guarantees (OK / în pericol / încălcat), visible in the UI |
| N7 | Security | Storages are not reachable from outside; FileGrid is the only path | The client never receives storage URLs or credentials; all downloads go through the API |
| N8 | Security | External traffic is encrypted and access to FileGrid is authenticated | HTTPS only, login, roles, session expiry |
| N9 | Security | Unauthorised direct storage access does not expose PII in connection documents | "Encrypted at rest" status on racordări files; PII masked in the UI by default |
| N10 | Security | No password or key in the repository | Only `.env.example`; nothing secret in `NEXT_PUBLIC_*` |
| N11 | Resilience | A storage outage does not stop the other categories and loses no confirmed file | Storage health strip; other categories keep uploading; clear error on the affected one |
| N12 | Resilience | On high latency + packet loss, transfers finish or resume with no manual intervention | Resumable chunked upload, automatic retry with backoff, resume after offline or reload |
| N13 | Resilience | Retries do not duplicate meter readings; a corrupt file is detected on retrieval | Dedup counter (duplicates rejected, lost = 0); a visible "Fișier corupt detectat" state |

### §5 Statistics and interpretation

| ID | Question the statistics must answer |
|---|---|
| S1 | Which storage type fits each data category best, and why? |
| S2 | How did the system behave on a peak day compared with a normal day? |
| S3 | What does the data say about the grid (patterns or anomalies in meter readings, zones with the most faults)? |

Rule from the brief: an interpretation useful to a human decision-maker matters more than the number of charts.
So every chart carries a plain-Romanian interpretation and a recommendation.

§6 (Spring Boot, Angular, Grafana/Loki/Prometheus, SQL DB) is a recommendation only; our stack is allowed.

## 4. Team and environment constraints

- **Frontend (me):** Next.js, App Router, TypeScript strict, in `frontend/`.
- **Backend (2 teammates):** NestJS. **The REST contract is not fixed yet**: keep every endpoint behind a typed
  client layer, and write each assumption down as a "backend ask" instead of hard-coding it.
- **Existing storage** (`infra/docker-compose.yml`, `make infra-up`): PostgreSQL 17, SeaweedFS S3 (bucket
  `filegrid`), pure-ftpd FTP. All ports bound to `127.0.0.1` only. Secrets live in `infra/.env`, generated by
  `infra/gen-env.sh` and git-ignored. The frontend never talks to storage directly.
- **Existing cluster** (`deploy/k8s/`, `make k8s-tls-up`): k3s + Traefik (permanent HTTP → HTTPS redirect) +
  cert-manager with Let's Encrypt (HTTP-01). Namespace `filegrid`; ingress for `ppc.filegrid.cc.cd`
  (TLS secret `ppc-filegrid-tls`) currently routes `/` to an nginx placeholder that the frontend will replace.
  Routing `/api` to NestJS on the same host is our assumption, not yet agreed. Cloudflare proxy: SSL Full (strict).
- **VPS: 4 GB RAM, 2 cores**, shared by k3s, storage, backend and frontend. Every container needs explicit
  requests and limits (the placeholder uses 16Mi / 64Mi). Keep the frontend lean (standalone build).
- **Jury = PPC / Rețele Electrice România.** The UI must feel like a PPC internal product: Romanian UI copy with
  correct diacritics (ș ț with comma below, U+0219 / U+021B; never cedilla ş ţ), English code and identifiers.

## 5. PPC design facts (verbatim from Appendix A of docs/frontend/PROMPTS.md, taken from their live CSS on 2026-11-14)

FileGrid serves **Rețele Electrice România** (the distribution operator), so its palette leads.

| Token | reteleelectrice.ro | ppcenergy.ro (PPC supplier) |
|---|---|---|
| primary | `#FF4B00` (orange) | `#163FE8` (PPC blue) |
| secondary | `#00A0DC` (cyan) | `#EDEEEF` (light grey) |
| other | dark-blue `#232936`, dark-blue 75% `rgba(35,41,54,.75)`, 50% `rgba(35,41,54,.5)` | third `#FF6447` (coral), forth `#00DC55` (green), fith `#0091BD` (teal) |
| frequent accents | `#555C5F` (grey text), `#313131` | `#FFDA00` (yellow), `#53A7FF` (light blue), `#0D0D0D` (text) |
| neutrals | grey `#D3D5D6`, light-grey `#E1E1E1`, dirty-white `#F5F5F5`, off-white `#FAFAFA`, light-orange `#FAEBE6` | white `#FFFFFF`, `#D3D5D6` |
| font | `PingLCG` (licensed, cannot be shipped; pick a free look-alike) | `PingLCG` |
| radii | 40px (pill buttons), 24px, 20px, 12px, 8px | 8px, 16px, 999px (pills) |

Layout patterns: logo on the left, account link on the top right ("Intră în cont"), mega-menu
(Racordarea la rețea, Măsurare, Întreruperi, Informații, Despre noi), four icon tiles under a
welcome block, wide photo cards (920×400) with title, one line and "Află mai multe", line-style
icons, documentary photography (technicians in PPE, substations, solar and wind). Tone:
institutional and reassuring ("Bun venit la Rețele Electrice!", "Suntem aproape de consumatori").
ppcenergy.ro is more promotional, second-person and price-led.

Do not reuse their logos or present FileGrid as an official PPC product.
