# FileGrid PPC: Frontend Prompt Playbook (Next.js)

Prompts to paste into Claude Code, in order. Each one starts a **fresh session** and reads the
files the previous prompts produced, so context never has to survive a reset.

- **P0** = must exist for the demo. **P1** = makes it a winner. **P2** = only if time is left.
- When a prompt says "STOP", review the output before pasting the next prompt.
- Run `/ecc:save-session` at the end of every session and `/ecc:resume-session` if a session dies mid-task.
- After Prompt 5, the feature prompts (6a–6h) can run **in parallel**, each in its own git worktree.

Source of truth: [docs/brief/FileGrid_PPC.pdf](../brief/FileGrid_PPC.pdf). `TASKS.md` is only an example and is **not** a guideline.

---

## Prompt 0: Standing context (P0, ~10 min)

```text
Read docs/brief/FileGrid_PPC.pdf completely, plus README.md, Makefile, infra/ and deploy/.
TASKS.md is only an illustrative example. Do NOT treat its stack, API or task split as
requirements.

Facts about our team:
- I (frontend) build the frontend in Next.js (App Router, TypeScript strict) inside frontend/.
- My two teammates build the backend in NestJS. The REST contract between us is not fixed yet.
- Storage (Postgres, SeaweedFS S3, FTP) and k3s + Traefik + cert-manager on ppc.filegrid.cc.cd
  already exist. The VPS has 4 GB RAM and 2 cores, so every container needs a memory limit.
- The jury is PPC / Rețele Electrice România. The UI must feel like a PPC internal product:
  Romanian UI copy (correct diacritics ș ț with comma below), English code and identifiers.

Create two files:
1. docs/frontend/context.md: a dense brief (<= 150 lines) that every later session will read
   first. Include: the 4 data categories with their business guarantees (table 2.1, translated
   to English and kept in Romanian), every functional and non-functional requirement from
   sections 3–5 that the FRONTEND must make visible or demonstrable at the live demo, the team
   constraints above, and the PPC design facts in Appendix A of docs/frontend/PROMPTS.md
   (copy them verbatim).
2. frontend/CLAUDE.md: the working rules for this folder: stack, commands (to be filled in
   later), "read docs/frontend/context.md first", conventions (Romanian copy and English code,
   no secrets in the repo, uploads never stream through the Next.js server, all colours come
   from design tokens), and "only edit frontend/ and docs/frontend/ unless asked".

Do not scaffold anything yet. Show me both files.
```

---

## Prompt 1: Product brainstorm, then PRD (P0, ~45 min, interactive)

```text
Read docs/frontend/context.md and frontend/CLAUDE.md.

Use the superpowers:brainstorming skill, then the ecc:plan-prd skill, to produce
docs/frontend/prd.md for the FileGrid frontend. Ask me questions one at a time. The goal is
to win the hackathon, so the PRD must be driven by THE LIVE DEMO. Start by drafting a 7-minute
jury demo script (beat by beat: what the presenter clicks, what the jury sees, which brief
requirement it proves) and derive the screens from it.

Personas: echipă de teren (uploads drone videos and fault records from bad connections),
dispecerat (needs fault records immediately), angajat racordări (connection documents with
personal data), auditor/manager (statistics, integrity proof, audit trail), and the jury.

Cover at least these capabilities and tie each one to a brief requirement:
1. Upload for the 3 manual categories: chunked, resumable after a dropped connection or a
   browser reload, automatic retry with backoff, pause/resume, constant memory for 1 GB+ files,
   SHA-256 computed client-side in a Web Worker and compared with the server's hash.
2. Search, filter and download with integrity proof: a "verified" badge, the hash shown, the
   download re-verified in the browser, and a visible state when corruption is detected.
3. File detail with a "chain of custody" timeline and a trace waterfall for one operation
   (request → policy → encryption → storage), with a deep link to Grafana/Loki by trace ID.
4. Policy editor per category (primary/fallback storage, encryption, chunk size, concurrency,
   retention), editable live with no code change, with diff and confirm.
5. "Garanții de business" board: the 4 requirements of table 2.1 as live status cards
   (OK / în pericol / încălcat), each with the metric that proves it (for example meter
   readings: received, unique, duplicates rejected, lost = 0), plus active alerts.
6. Observability per category × storage: p50/p95/p99, throughput, error rate.
7. Statistics with plain-Romanian interpretations a decision-maker can act on: which storage
   fits each category and why, normal day vs peak day, grid insights (consumption patterns,
   meter anomalies, a map of the most faults by zone across Muntenia/Banat/Dobrogea).
8. Live meter ingest view (readings/s, dedup counter) and simulator rate control.
9. A demo control room: 10x storm per category, stop/start a storage, corrupt a file, degrade
   the network, with the effect visible on the same screen (the bulkhead proof: the other
   categories' latency stays flat).
10. Auth (login, roles, session expiry), and an audit trail for connection documents with
    personal data masked by default.

For each feature write: user story, acceptance criteria, the backend data it needs, priority
(P0/P1/P2), and a "how we prove it live" line. Add a section "Backend asks" listing every
endpoint or event the frontend needs from the NestJS team. Mark open questions explicitly.
STOP after the PRD and wait for my review.
```

---

## Prompt 2: Architecture, ADRs and the API contract (P0, ~45 min)

```text
Read docs/frontend/context.md and docs/frontend/prd.md.

Use superpowers:dispatching-parallel-agents to run these four agents IN PARALLEL on the PRD.
Each one writes its own file under docs/frontend/architecture/:

- ecc:architect → frontend-architecture.md. Next.js App Router structure (route groups,
  server vs client components, where data fetching lives), state (TanStack Query for server
  state, a small store for the upload queue), forms (react-hook-form + zod), charts, i18n
  (Romanian default, English optional), and how /api reaches NestJS. Recommendation: same
  origin through Traefik path routing (/api → NestJS, / → Next) so large uploads never pass
  through the Next.js server, plus a dev-time rewrite in next.config. Also decide auth
  transport (httpOnly secure cookie set by NestJS is the default to evaluate).
- ecc:code-architect → upload-engine.md. The resumable upload design. Compare (a) the tus
  protocol (tus-js-client ↔ @tus/server in NestJS) and (b) a custom chunk API. Cover: chunk
  size from the category policy, parallel chunks, retry with exponential backoff and jitter,
  online/offline detection, resume after reload (IndexedDB), incremental SHA-256 in a Web
  Worker (hash-wasm, because WebCrypto cannot hash incrementally), constant memory
  (Blob.slice, never reading the whole file), and how idempotency and the final hash
  check work. Recommend one, with reasoning.
- ecc:security-reviewer → threat-model.md. Frontend threat model: token storage, CSRF, XSS
  in file names and metadata, CSP headers, PII masking for connection documents, no secrets in
  NEXT_PUBLIC_*, download links that never expose storage URLs, and HTTPS only.
- ecc:a11y-architect → accessibility.md. WCAG 2.2 AA plan for the design system, the upload
  progress (live regions), charts (data-table alternatives) and the colour contrast of the PPC
  palette in Appendix A of docs/frontend/PROMPTS.md (flag any token that fails contrast).

Then:
1. Use ecc:architecture-decision-records to record each decision in docs/adr/ (NNNN-*.md).
2. Use ecc:contract-first and ecc:api-design to write docs/api/openapi.frontend-proposal.yaml:
   every endpoint, schema, error shape, pagination and SSE/WebSocket stream from the PRD's
   "Backend asks". Make it something NestJS can match with @nestjs/swagger, so we later
   generate TS types with openapi-typescript from the backend's real /api-json.
3. Write docs/api/HANDOFF-backend.md: a one-page summary for my NestJS teammates of what the
   frontend needs, the decisions that affect them (upload protocol, auth cookie, trace-ID
   header, stream format), and what I need confirmed.
STOP and show me a summary of every decision and every conflict between the agents.
```

> After Prompt 2, send `HANDOFF-backend.md` to your teammates and agree the contract before Prompt 5.

---

## Prompt 3: Design direction and design system (P0, ~60 min, visual)

```text
Read docs/frontend/context.md, docs/frontend/prd.md, docs/frontend/architecture/accessibility.md
and Appendix A of docs/frontend/PROMPTS.md (the PPC / Rețele Electrice brand facts extracted
from their live CSS).

Use ecc:frontend-design-direction, then ecc:design-system, then the dataviz skill.

Direction: FileGrid must read as an internal tool of Rețele Electrice România (PPC group).
Base it on reteleelectrice.ro: white/off-white surfaces, dark-blue #232936 chrome, orange
#FF4B00 for primary actions, cyan #00A0DC for info and data, pill buttons, 12–24px card radii,
generous whitespace, documentary photography (technicians, substations, lines). Keep PPC blue
#163FE8 as the group accent. Do NOT copy PPC or Rețele Electrice logos or claim to be an
official PPC product. FileGrid has its own wordmark (an idea: a grid of chunks that fills up).
The footer reads "Prototip FileGrid · Hackathon PPC".

Deliver:
1. docs/frontend/design/direction.md: mood, principles (calm by default, loud only when a
   business guarantee is at risk), layout grid, density for control-room screens, motion
   rules (ecc:motion-foundations; respect prefers-reduced-motion).
2. Design tokens: colour (brand, neutrals, semantic status). IMPORTANT: the brand orange is
   close to "warning/danger", so define status colours that never get confused with the
   primary action. Plus typography, spacing, radii, shadows and elevation, light theme first
   and a dark "dispecerat" theme. Output as CSS variables usable by Tailwind v4 @theme, and
   a chart palette validated with the dataviz validator for both themes.
3. Font: the PPC sites use the licensed "PingLCG" (Typotheque Ping), which we cannot ship.
   Pick a free Google Font with a similar humanist-geometric feel that renders Romanian ș ț
   (comma-below) correctly. Test candidates such as Figtree, Manrope and Onest, and justify
   the choice.
4. A component inventory mapped to shadcn/ui (Radix) primitives with the PPC theme applied:
   app shell, sidebar, top bar with environment badge, data table, filters, upload dropzone,
   chunk-grid progress, integrity badge, status card, KPI tile, trace waterfall, timeline,
   policy form, alert banner, empty/error/loading states.
5. ASCII or HTML mockups of the 5 demo-critical screens: Upload, Fișiere, Detaliu fișier
   (trace), Garanții de business + Demo control room, Statistici. Offer me the visual
   companion and show them in the browser.

Then run /ecc:gan-design on the 5 mockups (at most 3 iterations; rubric: PPC familiarity,
clarity for a non-technical manager, demo legibility on a projector, accessibility).
STOP and let me pick and adjust before anything is coded.
```

---

## Prompt 4: Implementation plan (P0, ~30 min)

```text
Read docs/frontend/context.md, docs/frontend/prd.md, docs/frontend/architecture/*, docs/adr/*,
docs/api/openapi.frontend-proposal.yaml and docs/frontend/design/*.

Use superpowers:writing-plans to write the implementation plan in
docs/superpowers/plans/<date>-filegrid-frontend.md. Requirements for the plan:
- Vertical slices that are each demoable, in this order: 5 Foundation, 6a Shell+Auth,
  6b Upload engine, 6c Files+Integrity+Trace, 6d Policies, 6e Business guarantees + Observability,
  6f Statistics, 6g Demo control room + Meter live view, 6h Audit + i18n polish.
- Each task is bite-sized (2–5 min), test-first, and names exact files, test names and the
  commands to run. Mark P0/P1/P2 so I can cut scope when time is short.
- Everything runs against MSW mocks generated from the OpenAPI proposal, with one flag
  (NEXT_PUBLIC_API_MOCKS=0) to switch to the real NestJS backend.
- Mark which slices can run in parallel worktrees and which files would cause conflicts.
- A "definition of done" per slice: tests green, typecheck, lint, react-review clean, a11y
  checked, and the demo beat for it rehearsed.
Have ecc:planner review the plan for gaps and risk, apply its fixes, then STOP.
```

---

## Prompt 5: Foundation scaffold (P0, ~45 min)

```text
Read frontend/CLAUDE.md, docs/frontend/context.md and the plan in docs/superpowers/plans/.
Use superpowers:using-git-worktrees to work on branch feat/frontend-foundation.
Before writing config, use ecc:docs-lookup to confirm current APIs for Next.js (latest stable),
Tailwind v4, shadcn/ui, TanStack Query, MSW, next-intl and Playwright. Do not rely on memory.

Use superpowers:executing-plans for slice 5 only, with ecc:nextjs-turbopack and
ecc:frontend-patterns:
- Next.js in frontend/ with TypeScript strict, ESLint, Prettier, path aliases, `output: "standalone"`.
- Tailwind v4 + the design tokens from Prompt 3, the chosen font via next/font, shadcn/ui
  initialised and themed, light and dark themes.
- API layer: openapi-typescript types generated from the contract (script `gen:api`), a typed
  fetch client with a trace-ID header, error normalisation and 401 handling, TanStack Query
  provider, and MSW handlers generated or written from the contract with realistic Romanian
  fixtures (regions Muntenia/Banat/Dobrogea, substations, file names).
- Tests: Vitest + Testing Library (ecc:react-testing), Playwright (ecc:e2e-testing) with one
  smoke test, and coverage reporting.
- Security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors) in next.config or
  middleware, per docs/frontend/architecture/threat-model.md.
- frontend/Dockerfile: multi-stage, non-root user, standalone output, healthcheck, a
  .dockerignore, a documented memory limit of 256–384 MB, and no secrets baked in
  (ecc:docker-patterns). Write a frontend/.env.example only.
- package.json scripts: dev, build, start, lint, typecheck, test, test:e2e, gen:api.
- Fill the commands into frontend/CLAUDE.md.
Use superpowers:verification-before-completion: run build, typecheck, lint, test and the
docker build, and paste the real output. Commit with conventional commits. STOP.
```

---

## Feature prompts 6a–6h

Use this **same template** for every slice. Only the `SLICE` block changes.

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

### 6a: Shell and auth (P0)
```text
App shell per the design: sidebar (Panou, Încărcare, Fișiere, Contoare, Politici, Statistici,
Garanții & Alerte, Audit, Demo), top bar with user, role and environment badge, a global
alert banner slot. Login page with documentary hero imagery (licensed or self-shot), form
validation, error states, session expiry handling and redirect-back. Route protection in the
Next.js middleware/proxy, role-based navigation (teren, dispecerat, racordări, auditor,
admin). Empty, loading and error states everywhere. Keyboard navigation and a skip link.
```

### 6b: Resilient upload engine (P0, the most important slice)
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

### 6c: Files, integrity and trace (P0)
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

### 6d: Policies (P0)
```text
Politici: one card per category showing the active policy (primary storage, fallback,
encryption, chunk size, concurrency limit, retention). Editing uses react-hook-form + zod
with validation that mirrors the backend. Show a diff of old vs new before confirm, a
"takes effect immediately, no deploy" note, the change history (who and when), and
optimistic update with rollback on error. Admin role only.
```

### 6e: Business guarantees and observability (P1)
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

### 6f: Statistics and interpretation (P1, the jury's "wow" for decision-makers)
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

### 6g: Demo control room and meter live view (P0 for the demo)
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

### 6h: Audit and polish (P1/P2)
```text
Audit: an immutable log of who uploaded, viewed, downloaded or revealed PII on connection
documents, filterable and exportable. Optional English locale through next-intl. Dark
"dispecerat" theme toggle. Micro-interactions with ecc:make-interfaces-feel-better and
ecc:motion-patterns (honouring reduced motion).
```

---

## Prompt 7: Integration with the real NestJS backend (P0, ~as long as it takes)

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

---

## Prompt 8: Quality gate (P0, ~60 min)

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

---

## Prompt 9: Demo rehearsal (P0, the day before)

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

---

## Appendix A: PPC brand facts (taken from their live CSS on 2026-11-14)

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
