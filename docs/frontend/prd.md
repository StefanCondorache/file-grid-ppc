# FileGrid PPC: frontend PRD

*Status: DRAFT for review (2026-11-14). Requirements only: no libraries, protocols or file layout. Those are
decided in Prompt 2 (architecture docs + ADRs). Requirement IDs F*, N*, S* refer to
[context.md](context.md); the source of truth is [the brief](../brief/FileGrid_PPC.pdf).*

Decisions taken in the brainstorm (2026-11-14), binding for this PRD:

| # | Decision |
|---|---|
| D1 | The PRD is driven by a 7-minute live jury demo; screens are derived from the script (§6). |
| D2 | Failure injection is **hybrid**: storm (10× per category) and "corrupt a file" are in-app (demo control room); stopping a storage is done by a teammate from a terminal (`kubectl scale`); network degradation is real browser throttling/offline (Chrome DevTools) on a real upload. |
| D3 | The demo runs on the **live VPS** (`https://ppc.filegrid.cc.cd`) from the venue network, with a **recorded backup video**. |
| D4 | **Five real roles** with backend-enforced permissions: `teren`, `dispecerat`, `racordari`, `auditor`, `admin`. The presenter logs in once as `admin` and uses a **demo-only role switcher**. |
| D5 | The numbers shown in the UI (latency, throughput, errors, traces, statistics) come from a **NestJS operation log** persisted in Postgres, not from Prometheus. Grafana/Loki, if the team adds them, are an optional deep link; the demo must not depend on them. |
| D6 | **The demo is the hackathon final, ~22 hours from 2026-11-14 afternoon.** The 7-minute length is a target for pacing, not a hard limit. Scope is cut to what one frontend developer can ship in that window (§12). |
| D7 | **Mock-first, independent of the backend.** The frontend is built entirely against a mock API that follows the OpenAPI proposal (FE-18) and switches to the real NestJS API per endpoint as each one lands. No frontend milestone waits on the backend. |

---

## 1. Problem

Rețele Electrice România receives four kinds of field files (meter readings, fault records, connection documents
with personal data, drone videos) into FTP, S3 and databases that were picked ad hoc. Nobody can say from data
which storage suits which file type, and each guarantee the business needs (no lost or duplicated reading,
faults available immediately, personal data protected, big transfers that survive bad networks) is unproven.
For the hackathon, the cost of a weak frontend is concrete: the brief requires every non-functional requirement
to be **shown live** (§4), so a requirement we satisfy but cannot make visible scores as missing.

## 2. Evidence

- Brief §1: "Nimeni nu poate spune, pe baza unor date, care sistem e potrivit pentru ce tip de fișier."
- Brief §4: "Cum le îndepliniți e decizia voastră. La demo trebuie să puteți arăta live că sunt respectate."
- Brief §5: "Contează mai mult ca interpretarea să fie utilă unui om care ia decizii decât numărul de grafice."
- Persona pains (field teams on unstable connections, dispatch needing faults immediately) are taken from the
  brief's table 2.1. Assumption, not user research: needs validation via the jury's reaction in rehearsal with
  an outside viewer.

## 3. Users

| Persona (role) | Context | Trigger | What they need from FileGrid |
|---|---|---|---|
| **Echipă de teren** (`teren`) | Field crew, often on mobile data in the field, uploading drone videos (100 MB–1 GB+) and fault records | After an inspection or a storm | An upload that survives drops, reloads and slow links with no babysitting |
| **Dispecerat** (`dispecerat`) | Control room, restoring supply | A fault record arrives | Fault records visible the moment they land, newest first |
| **Angajat racordări** (`racordari`) | Back office processing connection requests | A customer files a request | Upload ID documents and permits; personal data hidden by default |
| **Auditor / manager** (`auditor`) | Compliance and decision-makers | Audit, monthly review, post-storm review | Integrity proof, audit trail, statistics with a plain-Romanian recommendation |
| **Administrator** (`admin`) | The team; the demo presenter | Configuration, demo | Policies, health, demo controls, role switcher |
| **Jury** (PPC / Rețele Electrice) | Watches 7 minutes | The demo | Every requirement visibly proven; a product that feels like an internal PPC tool |

**Not for:** customers or the public (no self-service portal), smart meters (they talk to the API, not the UI),
storage operators (no direct storage console).

## 4. Hypothesis

We believe **a demo-first UI that turns every brief guarantee into a live, visibly-proved state** (counters,
badges, hashes, side-by-side latency, traces) will **convince the PPC jury that every §3–§5 requirement holds**.
We'll know we're right when **an outside viewer at rehearsal can name which requirement each beat proved, and
the full script runs in ≤ 7:00 with no manual recovery three rehearsals in a row**.

## 5. Success metrics

| Metric | Target | How measured |
|---|---|---|
| Script pacing | ≈ 7 min (target, not a limit), 2 rehearsals without manual recovery | Stopwatch at rehearsal |
| Requirement coverage | Every F1–F8 gate item and N1, N3–N9, N11–N13, S1–S3 has a beat or a screen; N2, N10, F5, F8 covered by README/narration | Traceability matrix (§9) |
| Upload resilience | 1 GB+ upload resumes after offline and after reload, 0 manual retries (re-selecting the file after reload counts as allowed, see OQ-1) | Rehearsal on venue-like network (throttled) |
| Browser memory | Tab memory does not grow with file size during a 1 GB+ upload (target: < 300 MB tab total; TBD: validate in Chrome Task Manager) | Chrome Task Manager during rehearsal |
| Fault availability | Upload-complete → visible in dispatcher list shown on screen; target < 2 s on the VPS (TBD: validate against backend) | Timer in UI, backed by backend timestamps |
| Accessibility | WCAG 2.2 AA on demo screens; Lighthouse accessibility ≥ 95 | Lighthouse + axe |
| Copy correctness | 0 cedilla ş ţ in UI strings | Lint/grep in CI |
| Frontend footprint | Container runs within an explicit memory limit (target ≤ 256 Mi; TBD: measure) | `kubectl top` on VPS |

---

## 6. The 7-minute jury demo script

Presenter at the laptop (logged in as `admin`, Chrome, DevTools docked), a teammate at a terminal. Before the
demo: seed history loaded (FE-14), one drone video uploaded and verified, simulator at "normal".

| Time | Beat · persona | Presenter does | Jury sees | Proves |
|---|---|---|---|---|
| 0:00–0:30 | **1 · Opening** · admin | Opens `https://ppc.filegrid.cc.cd`, logs in | Lock icon/HTTPS; "Garanții de business" board: 4 green cards; storage health strip (Postgres · S3 · FTP); meter counter ticking (primite / unice / duplicate respinse / pierdute = 0) | N8, F2, N6, F7, N13 |
| 0:30–1:45 | **2 · Drone upload on a bad network** · teren (switcher) | Drags a 1 GB+ drone video, fills line/zone; mid-upload: DevTools → Offline, back Online; then F5 | Hash computed in background, chunk progress, speed, ETA; "Conexiune pierdută: reluăm automat"; resumes by itself; after reload the queue is restored and continues from the same %; memory flat (Chrome Task Manager). Upload keeps running in the tray for the rest of the demo | N12, N3, F1, F6 |
| 1:45–2:30 | **3 · Fault record** · dispecerat | Uploads a 5 MB fault record (zone, substation, severity) | "Disponibil pentru dispecerat în 1,2 s"; it appears at the top of the live fault list without refresh | Fault guarantee, F6 |
| 2:30–3:15 | **4 · Connection document** · racordari → auditor | Uploads an ID scan + request; opens the list; switches to auditor, clicks "Arată datele" with a reason; opens audit trail | Name/CNP masked by default; "Criptat în repaus" badge; racordari cannot unmask; auditor unmasks with a reason; the unmask appears in the audit trail | N9, N8 (roles), connection-docs guarantee |
| 3:15–4:30 | **5 · Storm** · admin, control room | Clicks "Furtună 10× · avarii"; teammate stops S3 (`kubectl scale … --replicas=0`), then restores it | Per-category latency side by side: faults climb, meters/docs/drone stay flat; category × storage matrix (p50/p95/p99, throughput, error rate); the faults card turns "În pericol", an alert banner appears; S3 tile turns red, affected category shows a clear error or "Scris pe fallback", other categories keep working; S3 back to green | N1, N4, N6, N11, N13 |
| 4:30–5:30 | **6 · Integrity and trace** · auditor | Opens the pre-uploaded drone video; then control room → "Corupe fișier" on a fault record → downloads it | Client hash = server hash, "Verificat" badge, re-verified download; chain-of-custody timeline; trace waterfall (cerere → politică → criptare → storage) with trace ID; then **"Fișier corupt detectat"** with both hashes | F4, N5, N13, N7 (download via API only) |
| 5:30–6:00 | **7 · Policy, live** · admin | Changes faults: primary S3 → FTP; sees the diff; confirms; uploads one fault | The new file's detail says "Stocat pe FTP · politica v4"; no deploy, no code | F3, F2 |
| 6:00–7:00 | **8 · Statistics** · auditor/manager | Opens Statistici | S1: storage fit per category with the why; S2: normal day vs the storm just run; S3: map of faults by zone and meter anomalies; every chart has a 1–2 sentence Romanian interpretation and recommendation | S1, S2, S3 |

Narrated without a beat: N2 (capacity grows by adding instances, optional P2 view), N10 and F5 (README, one
command, `.env.example`), F8 (repo). The drone upload from beat 2 is shown at 100 % only if it finishes in time;
the beat proves resilience, not completion.

## 7. Screens (derived from the script)

UI names are the Romanian labels; the route structure is decided in Prompt 2.

| # | Screen | Used in beats | Roles |
|---|---|---|---|
| SC-01 | **Autentificare**: login, session-expired state | 1 | all |
| SC-02 | **Garanții de business** (home): 4 guarantee cards, active alerts, storage health strip, meter counters | 1, 5 | all (read) |
| SC-03 | **Încărcare**: category + metadata form, drop zone, queue; plus a global **upload tray** visible on every screen | 2, 3, 4, 7 | teren, dispecerat, racordari, admin |
| SC-04 | **Fișiere**: search, filters, list per category incl. meter readings, live-updating fault list | 3, 4 | per role/category |
| SC-05 | **Detaliu fișier**: metadata (masked PII), storage + policy version, hashes + integrity badge, chain of custody, trace waterfall, download | 6, 7 | per role/category |
| SC-06 | **Politici**: per-category policy view/edit with diff and confirm, version history | 7 | admin (edit), auditor (read) |
| SC-07 | **Observabilitate**: category × storage matrix, per-category latency over time | 5 | auditor, admin |
| SC-08 | **Statistici**: S1/S2/S3 with interpretations | 8 | auditor, admin |
| SC-09 | **Contoare live**: ingest rate, dedup counters, recent readings, simulator rate control | 1, 5 | admin (control), auditor/dispecerat (read) |
| SC-10 | **Cameră de control demo**: storm per category, corrupt a file, simulator rate, same-screen effect panel | 5, 6 | admin, demo mode only |
| SC-11 | **Jurnal de audit**: who did what on which file, filterable; unmask events with reason | 4 | auditor, admin |
| — | Global chrome: header with role switcher (demo mode), alert banner, storage health strip, upload tray, session-expiry warning | all | — |

## 8. Features

Priority: **P0** = in the script or the F-gate; **P1** = makes it a winner; **P2** = if time is left.

### FE-01 Authentication, session, roles, demo role switcher · P0 · F6, N8

- **Story:** As any staff member I log in and only see what my role allows, so personal data and controls stay
  with the right people. As the presenter I switch persona in one click so the demo doesn't stall on logins.
- **Acceptance criteria:**
  - Login with username + password; Romanian error messages; no indication of which field was wrong.
  - Session expiry is visible: warning 2 min before, then a redirect to login that returns to the same page; an
    upload in progress resumes after re-login.
  - Navigation, actions and data are filtered by role (matrix below). The UI hiding is convenience only; every
    rule is enforced by the backend.
  - Role switcher appears only when the backend reports demo mode on and the real user is `admin`; every switch
    is written to the audit trail; the header always shows the active role ("Rol activ: Auditor").
  - Logout clears all client-side session state; upload queue metadata survives (no file bytes or PII stored).
  - *(Builder call, review)* An upload is authorised **once, when it starts**, for the real user and the role
    active at that moment; its later parts are accepted because they belong to that upload, not re-checked
    against the role active now. Switching role never cancels or breaks a running upload; the tray shows which
    role started each upload. After logout, only the same real user can resume it.
- **Backend data:** BA-01..BA-04.
- **Live proof:** beat 1 (login over HTTPS), beat 4 (racordari cannot unmask, auditor can).

Role × capability matrix (backend-enforced):

| Capability | teren | dispecerat | racordari | auditor | admin |
|---|---|---|---|---|---|
| Upload drone video | ✓ | | | | ✓ |
| Upload fault record | ✓ | ✓ | | | ✓ |
| Upload connection document | | | ✓ | | ✓ |
| View/download drone · faults | ✓ | ✓ | | ✓ | ✓ |
| View/download connection docs (masked) | | | ✓ | ✓ | ✓ |
| Unmask personal data (with reason) | | | | ✓ | |
| View meter readings | | ✓ | | ✓ | ✓ |
| Guarantees board, health strip | ✓ | ✓ | ✓ | ✓ | ✓ |
| Observability, statistics | | | | ✓ | ✓ |
| Audit trail | | | | ✓ | ✓ |
| Edit policies | | | | | ✓ |
| Demo control room, role switcher, simulator rate | | | | | ✓ (demo mode) |

Note: `admin` cannot unmask personal data; the presenter switches to `auditor` to do it. That is deliberate.

### FE-02 Resilient upload for the 3 manual categories · P0 · F1, F6, N3, N12, F4

- **Story:** As an echipă de teren member on a bad connection I drop a 1 GB drone video and walk away; it
  finishes or resumes by itself, and FileGrid proves the stored file is the one I sent.
- **Acceptance criteria:**
  - Category choice limited to the user's roles; per-category metadata form validated before upload:
    - Fault: zone (Muntenia / Banat / Dobrogea), substation, event time, severity.
    - Connection document: request number, document type (cerere / act de identitate / aviz), applicant name,
      CNP (validated format; personal data).
    - Drone video: line/section, zone, inspection date.
  - Drag-and-drop and file picker; several files queue; per-file state, %, bytes, speed, ETA.
  - Limits come from the category policy (max size, allowed types, chunk size, parallelism), never hard-coded;
    a file that breaks the policy is rejected before upload with the reason.
  - States (Romanian copy): în așteptare · se calculează amprenta · se încarcă · în pauză · conexiune pierdută,
    reîncercare în N s · se verifică · verificat · eșuat (with reason and trace ID).
  - Pause, resume, cancel per file.
  - Going offline pauses automatically; coming back online resumes with no click. A failed chunk is retried
    with increasing waits; a permanently failed upload says why.
  - After a reload or a closed tab, the queue reappears and continues from the last confirmed byte. If the
    browser can't reopen the file by itself, the user is asked once to re-select it and FileGrid checks it is
    the same file before continuing (see OQ-1).
  - The browser never holds the whole file in memory; the UI stays responsive (no frozen frames) while the
    SHA-256 is computed.
  - The client SHA-256 is shown and compared with the server's hash at completion. Mismatch → the upload is
    marked failed ("Amprenta nu coincide") and the file is not shown as available.
  - The upload tray persists across navigation.
  - On completion: link to the file detail; for faults also "Disponibil pentru dispecerat în X s".
  - Bytes go from the browser to the API directly, never through the Next.js server.
- **Backend data:** BA-10..BA-15, BA-05 (policy).
- **Live proof:** beat 2 (offline, online, reload, memory flat), beat 3 (fault available time).

### FE-03 Search, filter, browse (incl. meter readings) · P0 · F1, F6

- **Story:** As a dispecer I see new fault records the moment they land; as anyone I find a file by what I know
  about it.
- **Acceptance criteria:**
  - Lists per category (drone, faults, connection docs, meter readings), each filtered by the user's roles.
  - Filters: category, zone, date range, uploader, integrity state, storage; text search on file name and
    non-personal metadata. Personal data is never searchable in clear text (search by request number is fine).
  - Sorting by date (default newest first) and size; paginated; filter state in the URL (shareable).
  - The fault list updates live (a new record appears on top without refresh, announced to screen readers).
  - Each row shows: name, category, size, uploaded at, storage, integrity badge, "Criptat" badge where relevant.
  - Empty, loading and error states in Romanian; error shows the trace ID.
- **Backend data:** BA-16, BA-30 (meter readings), BA-60 (live events).
- **Live proof:** beat 3 (fault pops in), beat 4 (masked list).

### FE-04 Download with integrity re-verification · P0 · F4, N7, N13

- **Story:** As an auditor I download a file and see proof that it is identical to what was uploaded, or a loud
  warning that it isn't.
- **Acceptance criteria:**
  - Every download goes through the FileGrid API; no storage URL, bucket, FTP path or credential ever reaches
    the browser (not in responses, headers, HTML or logs).
  - The browser recomputes SHA-256 of the downloaded bytes and compares it with the stored hash; badge states:
    **Verificat** · **Verificat de server** · **Neverificat** · **Fișier corupt detectat**.
  - For large files (drone videos), verification must not hold the file in memory; if in-browser
    re-verification is not feasible for a size, the UI offers server-side verification instead and says which
    one was done.
  - When the backend detects corruption at retrieval, the UI shows "Fișier corupt detectat" with expected vs
    actual hash, the storage, the trace ID and what to do next (e.g. restore from fallback if a copy exists).
- **Backend data:** BA-17, BA-18.
- **Live proof:** beat 6 (verified download, then the corrupted one).

### FE-05 File detail: chain of custody and trace · P0 · F2, F4, N5

- **Story:** As an auditor I open one file and follow it from the first request to the storage that holds it.
- **Acceptance criteria:**
  - Shows metadata (personal data masked), size, type, category, uploader, storage label (S3 / FTP / Postgres;
    never a URL), policy name + version applied, encryption at rest (yes/no, algorithm label), fallback used
    (yes/no), client and server SHA-256 side by side, integrity badge.
  - **Chain of custody** timeline: created, each upload session, completed, verified, policy applied, stored,
    each download, each verification, each unmask (who, when, reason), corruption detected.
  - **Trace waterfall** for one operation by trace ID: spans with durations (cerere → autentificare → politică
    → criptare → storage → confirmare); errors highlighted; copyable trace ID; optional "Deschide în Grafana"
    link only if configured.
  - Readable as a table for screen readers.
- **Backend data:** BA-17, BA-19, BA-20.
- **Live proof:** beat 6, beat 7 ("Stocat pe FTP · politica v4").

### FE-06 Policy editor · P0 · F3, F2

- **Story:** As an admin I change where and how a category is stored, live, and the next upload obeys it.
- **Acceptance criteria:**
  - Per category: primary storage, fallback storage, encryption at rest (on/off; forced on for connection
    documents and shown as locked), chunk size, max parallel chunks, max file size, allowed types, retention.
  - Validation with reasons (e.g. fallback ≠ primary, chunk size within backend limits).
  - Before saving: a diff (old → new) and a confirm step; on save, a new version number; version history list.
  - If someone else changed the policy meanwhile, saving fails with a clear message and the new diff
    (no silent overwrite).
  - Uploads already in progress keep the policy they started with; the UI says so.
- **Backend data:** BA-05..BA-07.
- **Live proof:** beat 7.

### FE-07 "Garanții de business" board and alerts · P0 · N6, N13, table 2.1

- **Story:** As anyone on the team I see at a glance whether each business guarantee holds, and I'm told when
  one is at risk.
- **Acceptance criteria:**
  - Four cards, one per category guarantee, each with status **OK · În pericol · Încălcat**, the proving metric
    and its threshold:
    - Citiri contoare: primite / unice / duplicate respinse / pierdute (must be 0).
    - Avarii: upload-to-available p95 vs target.
    - Racordări: % encrypted at rest (must be 100 %), unmask events today, last audit check.
    - Video dronă: transfers completed / resumed / failed, success rate.
  - Status is computed by the backend (thresholds live there); the UI never decides a status.
  - Status uses text + icon + colour, never colour alone; changes are announced politely to screen readers.
  - Alert banner on every screen when any guarantee is not OK; alert list with time, guarantee, cause, trace
    link, acknowledge (who/when). Browser notifications (opt-in) are P1.
- **Backend data:** BA-40, BA-41, BA-60.
- **Live proof:** beat 1 (all green), beat 5 (faults turn "În pericol", alert fires).

### FE-08 Storage health strip and fallback visibility · P0 · F2, N11

- **Acceptance criteria:**
  - A compact strip on every screen: Postgres · S3 · FTP, each with status (OK / degradat / căzut), last check,
    latency; links to the observability screen.
  - Upload to a category whose storage is down: clear Romanian error naming the storage and that other
    categories are unaffected, or "Scris pe fallback: FTP" if the backend wrote to the fallback.
  - Files written to fallback carry a badge in lists and detail.
- **Backend data:** BA-42, BA-60.
- **Live proof:** beat 5 (S3 red, others continue, back to green).

### FE-09 Observability: category × storage · P0 (matrix) / P1 (history) · N4, N1

- **Acceptance criteria:**
  - Matrix: rows = 4 categories, columns = 3 storages; each cell p50 / p95 / p99, throughput, error rate for a
    selectable window (5 min, 1 h, 24 h); cells with no traffic say so.
  - "Bulkhead" panel: per-category latency over the last minutes on one shared time axis, so a storm in one
    category visibly leaves the others flat.
  - Every chart has an equivalent data table.
  - Live refresh during the demo without the page jumping.
- **Backend data:** BA-43, BA-44, BA-60.
- **Live proof:** beat 5.

### FE-10 Statistics with interpretation · P0 (S1, S2 core) / P1 (S3 map, anomalies) · S1, S2, S3

- **Story:** As a manager I get answers, not charts: which storage to use for what, how the storm went, what the
  grid data says.
- **Acceptance criteria:**
  - **S1 · Storage potrivit:** per category, the measured latency/throughput/error rate on each storage that
    served it, and a recommendation with the why (e.g. "Avarii → S3: p95 de 3× mai mic decât FTP la fișiere de
    5 MB").
  - **S2 · Zi normală vs zi de vârf:** the same metrics for a labelled normal period and a peak period (incl. the
    storm just run), with the difference and an interpretation.
  - **S3 · Ce spun datele despre rețea:** faults by zone on a map of Muntenia / Banat / Dobrogea (granularity
    per OQ-6); meter consumption pattern by hour and zone; list of meter anomalies (e.g. zero or negative
    consumption, sudden spikes, silent meters).
  - Every block: 1–2 sentences of plain Romanian interpretation + one recommendation. Interpretations are
    generated by the backend from the numbers (rule-based text is acceptable) or templated in the UI from
    backend facts; never hard-coded prose that ignores the data.
  - Every chart has a data-table alternative; colour is never the only encoding.
- **Backend data:** BA-50..BA-53, BA-70 (seed history).
- **Live proof:** beat 8.

### FE-11 Live meter view and simulator rate control · P0 · F7, N13

- **Acceptance criteria:**
  - Live readings/s, totals (primite / unice / duplicate respinse / pierdute), recent readings table, per-zone
    split.
  - Admin (demo mode): switch simulator between **Zi normală** and **Zi de vârf**, or set readings/s; the
    current rate is always visible.
  - Meter readings can be browsed and downloaded (F1). *(Builder call, review)* Each reading is **both** a stored
    file (raw payload, SHA-256, stored per the meter policy like any other file) **and** parsed fields (meter
    ID, zone, timestamp, kWh, sequence) used for counters and statistics. Because of the volume, readings get
    their own table view (filter by meter, zone, time) rather than the generic file list; one reading opens
    the normal file detail (hash, storage, policy, chain of custody) and downloads its raw payload. Export of
    a time range is P2.
- **Backend data:** BA-30..BA-32, BA-60.
- **Live proof:** beat 1, beat 5.

### FE-12 Demo control room · P0 · N1, N6, N11, N13

- **Acceptance criteria:**
  - Only for `admin` and only when the backend reports demo mode on; every action asks for confirmation and is
    audited.
  - **Furtună 10×** per category (start/stop, factor, duration) with a countdown.
  - **Corupe fișier**: pick a file; the backend alters the stored bytes (not the hash); the UI then guides to
    download it.
  - **Simulator**: normal / vârf (same control as FE-11).
  - *(Builder call, review)* Storm and simulator traffic is **real data with an origin tag** (`manual`,
    `simulator`, `storm`, `seed`). It appears everywhere real data does (fault list, search, map, guarantee
    cards, audit), because that is what the jury must see; lists and statistics offer a filter "Ascunde datele
    generate". Starting and stopping a storm makes the backend record a labelled **peak period**; the seed
    run provides labelled normal and peak days. S2 compares two labelled periods chosen from a list (default:
    last normal day vs the most recent peak), not free date ranges.
  - Same-screen effect panel: bulkhead latency panel (FE-09), guarantee cards (FE-07), health strip (FE-08).
  - A helper panel lists the terminal commands for the teammate (stop/start S3) as copy-paste text; the UI does
    not call Kubernetes.
- **Backend data:** BA-31, BA-61, BA-62, BA-63.
- **Live proof:** beats 5 and 6.

### FE-13 Personal data protection and audit trail · P0 · N9, connection-docs guarantee

- **Acceptance criteria:**
  - Personal fields (applicant name, CNP, address if present) are masked by default everywhere (lists, detail,
    search results, exports, page titles, notifications), e.g. "I*** P***", "1********123".
  - Only `auditor` can reveal, one file at a time, after entering a reason (min. length); revealed values
    disappear on navigation or after a short timeout; the reveal is written to the audit trail.
  - File names that contain personal data are masked too (backend returns a display-safe name).
  - Audit trail screen: filter by user, action, file, date; columns who / what / when / reason / trace ID;
    export is P2.
  - "Criptat în repaus" badge with the algorithm label on every connection document.
- **Backend data:** BA-21, BA-22.
- **Live proof:** beat 4.

### FE-14 Demo readiness · P0 · S2, D3

- **Acceptance criteria:**
  - A seed run gives at least one labelled **normal day** and one **peak day** of history before the demo.
  - A rehearsal checklist in `docs/frontend/` (accounts, demo mode on, seed loaded, pre-uploaded drone video,
    simulator at normal, DevTools ready, teammate terminal ready, backup video ready).
  - A recorded backup video of the full script, made on the real system.
  - Demo mode can be switched off for the "production" view; nothing demo-only is visible when it is off.
- **Backend data:** BA-70, BA-71.

### FE-15 Deployment and footprint · P0 · F5, N10

- **Acceptance criteria:** the frontend joins the single start command; container with explicit memory
  request/limit; `.env.example` only; nothing secret in browser-exposed config; HTTPS only (no mixed content);
  security headers (CSP etc., detailed in the threat model).

### FE-16 Language and devices · P0 (Romanian, keyboard, AA) / P2 (English, phone)

- Romanian only, with correct comma-below diacritics (P0). English is P2 given the 22-hour window; strings
  still live in one catalogue so it can be added later.
- Demo target: laptop at ≥ 1440 px. Phone layouts are P2. All demo screens keyboard-operable and
  WCAG 2.2 AA (P0).

### FE-18 Mock API and per-endpoint switch-over · P0 · D7

- **Story:** As the frontend developer I build and demo every screen without waiting for NestJS, then switch to
  the real API one endpoint at a time without touching components.
- **Acceptance criteria:**
  - A mock API in the browser/dev server that implements the OpenAPI proposal, with realistic seed data for all
    4 categories, 3 storages, 5 roles, guarantees, alerts, metrics, traces and statistics.
  - The mock also simulates the live stream (counters ticking, a storm, a storage going down, a corrupt file)
    and a resumable upload, so beats 1–8 can be rehearsed on mocks alone.
  - Each endpoint group can be pointed at mock or real independently by configuration; the UI shows a small
    "date simulate" marker when any mock is active, and it is impossible to ship to the VPS with mocks on
    unless explicitly enabled (demo fallback).
  - Components never know whether data is mocked (all access through the typed API client).
- **Backend data:** none; consumes `docs/api/openapi.frontend-proposal.yaml`.
- **Live proof:** none by itself; it is the safety net if a backend endpoint is late on demo day.

### FE-17 Capacity view · P2 · N2

- Instances per service and throughput before/after scaling, if the backend exposes instance counts.

---

## 9. Traceability: brief requirement → feature → beat

| Req | Feature(s) | Beat |
|---|---|---|
| F1 store/retrieve 4 categories | FE-02, FE-03, FE-04, FE-11 | 2, 3, 4, 6 |
| F2 FTP + S3 + DB really used | FE-05, FE-06, FE-08 | 1, 7 |
| F3 policy configurable live | FE-06 | 7 |
| F4 identical file, provable | FE-02, FE-04, FE-05 | 6 |
| F5 one command | FE-15 | narrated |
| F6 UI upload/search/download | FE-02, FE-03, FE-04 | 2, 3 |
| F7 meter simulator, configurable | FE-11, FE-12 | 1, 5 |
| F8 code in repo | — | narrated |
| N1 10× peak isolated | FE-09, FE-12 | 5 |
| N2 scale by instances | FE-17 | narrated (P2) |
| N3 1 GB+ constant resources | FE-02 | 2 |
| N4 p50/p95/p99 per category × storage | FE-09 | 5 |
| N5 trace one operation | FE-05 | 6 |
| N6 automatic notification | FE-07 | 5 |
| N7 storage only via FileGrid | FE-04 | 6 |
| N8 HTTPS + auth | FE-01, FE-15 | 1 |
| N9 PII safe on direct storage access | FE-13 | 4 |
| N10 no secrets in repo | FE-15 | narrated |
| N11 storage outage isolated | FE-08 | 5 |
| N12 transfer survives bad network | FE-02 | 2 |
| N13 no duplicate readings; corruption detected | FE-07, FE-11, FE-04 | 1, 5, 6 |
| S1 / S2 / S3 | FE-10 | 8 |

---

## 10. Backend asks (for the NestJS team)

What the frontend needs, described as capabilities and data. Exact paths, protocols and payload shapes are
proposed in `docs/api/openapi.frontend-proposal.yaml` (Prompt 2) and agreed with the team; until then these are
asks, not a contract.

**Cross-cutting**
- BA-00a Every response carries a **trace ID** header; errors use one shape: machine code, human-safe message,
  field errors, trace ID. Timestamps ISO 8601 UTC; IDs opaque.
- BA-00b Lists use one pagination style and return a total or a "has more" flag.
- BA-00c No storage URL, bucket key, FTP path or credential in any response; storage is a label (S3/FTP/DB).
- BA-00d The API is reachable from the browser on the same public host (`/api`) over HTTPS, so uploads and
  downloads never pass through the Next.js server. (Routing decided in Prompt 2.)
- BA-00e The backend exposes an OpenAPI document the frontend can generate types from.

**Auth and session**
- BA-01 Log in / log out; session with an expiry the UI can read.
- BA-02 "Who am I": user, roles, session expiry, demo mode on/off.
- BA-03 Role enforcement on every endpoint per the matrix in FE-01.
- BA-04 Demo-only role switch for `admin` (audited; refused when demo mode is off).

**Policies**
- BA-05 Read all category policies (fields in FE-06) incl. version.
- BA-06 Update one policy with the version I edited (reject if stale); returns the new version.
- BA-07 Policy version history per category.

**Upload**
- BA-10 Start an upload for a category with metadata and the client's declared size/type; returns an upload ID
  and the chunk parameters from the policy.
- BA-11 Send a part of the file; sending the same part twice is harmless.
- BA-12 Ask which parts the server already has (for resume after offline or reload).
- BA-13 Finish an upload with the client's SHA-256; the server answers with its own SHA-256, the verdict, the
  file ID, storage label, policy version, and for faults the "available at" time.
- BA-14 Cancel an upload; abandoned uploads are cleaned up server-side.
- BA-15 Upload limits per category in the policy (max size, types, chunk size, parallelism).
  *Protocol (tus vs custom chunk API) is decided in Prompt 2.*

**Files**
- BA-16 Search/list files with the filters in FE-03, per role.
- BA-17 File detail per FE-05 (masked personal data, display-safe name).
- BA-18 Download a file through the API, with its stored SHA-256 available before or with the bytes, range
  support for large files, and a distinct error when corruption is detected at retrieval.
- BA-19 Chain-of-custody events for a file.
- BA-20 Trace for one operation by trace ID (spans with name, start, duration, status, storage), from the
  operation log (D5).
- BA-21 Reveal personal data for one file (auditor only, reason required), audited.
- BA-22 Audit trail list with filters.

**Meters**
- BA-30 List/browse/download meter readings.
- BA-31 Simulator status and rate control (normal / peak / readings per second). *Owner of the simulator: OQ-3.*
- BA-32 Live meter counters: received, unique, duplicates rejected, lost; readings per second.

**Guarantees, alerts, health, metrics**
- BA-40 Status of the 4 guarantees with metric, threshold and state (OK / at risk / violated).
- BA-41 Alerts list and acknowledge.
- BA-42 Storage health per storage (status, latency, last check, circuit state).
- BA-43 Category × storage metrics (p50/p95/p99, throughput, error rate) for a window, from the operation log.
- BA-44 Per-category latency time series for the bulkhead panel.

**Statistics**
- BA-50 S1: per category × storage measured performance + recommendation facts.
- BA-51 S2: metrics for labelled normal vs peak periods.
- BA-52 S3: faults by zone; meter consumption by hour and zone; meter anomalies.
- BA-53 Interpretation text or the facts needed to template it (OQ-7).

**Live updates**
- BA-60 A push stream for: meter counters, guarantee status, alerts, storage health, new fault records, demo
  action progress. *Format (SSE vs WebSocket) is decided in Prompt 2.*

**Demo**
- BA-61 Start/stop a 10× storm for a category (factor, duration), demo mode only.
- BA-62 Corrupt a stored file (bytes changed, stored hash kept), demo mode only, audited.
- BA-63 Demo mode flag, off by default.
- BA-64 Every stored item carries an origin tag (`manual` / `simulator` / `storm` / `seed`), filterable in lists
  and statistics; a storm start/stop records a labelled peak period; list of labelled periods for S2.
- BA-65 Upload authorisation is checked at upload start and bound to that upload (survives role switch and
  re-login by the same real user).
- BA-33 Meter readings stored as raw payload + parsed fields; a reading has the same detail shape as a file.
- BA-70 Seed history: at least one labelled normal day and one labelled peak day.
- BA-71 Operation log persisted (D5) so statistics survive restarts.

## 11. Non-goals and out of scope

- Customer-facing portal, public sign-up, password reset by email: not in the brief.
- Editing or versioning file contents; files are immutable once stored.
- Deleting files from the UI (retention is policy-driven): avoids a destructive action in a 7-minute demo.
- The UI talking to Kubernetes, storages or Prometheus directly.
- Building our own Grafana: the operation log feeds our own charts; Grafana is optional.
- Offline-first app/PWA install: resilience is in the upload, not the whole app.
- Email/SMS/webhook alerting from the frontend (backend's job, P2).

Anti-goals (would be a failure even if it works): a demo that needs the network to be good; a beat whose
proof is "trust us"; any personal data visible in clear text on screen without an audited reveal; a screen
that looks like a generic admin template rather than a Rețele Electrice internal tool.

## 12. Delivery milestones

Time-boxed to the 22-hour window (H+0 = PRD approval). Everything up to milestone 10 runs on mocks (D7);
milestone 11 runs continuously from the moment the first real endpoint exists, not at the end.

| # | Milestone | Outcome | Window | Plan |
|---|---|---|---|---|
| 1 | Contract + architecture | OpenAPI proposal + backend handoff **sent to the NestJS team first**; architecture docs and ADRs | H+0 → H+1.5 | Prompt 2 |
| 2 | Tokens + plan | Design tokens, base components, implementation plan (Prompts 3 and 4 merged, short) | H+1.5 → H+2.5 | Prompts 3–4 |
| 3 | Scaffold + mock API | App runs, deploys, mock API (FE-18) serves seed data: **coding starts here** | H+2.5 → H+3.5 | Prompt 5 |
| 4 | Shell + auth | Login, roles, switcher, global chrome | H+3.5 → H+5 | 6a |
| 5 | Resilient upload | Beats 2 and 3 on mocks | H+5 → H+8 | 6b |
| 6 | Files, integrity, trace, audit | Beats 4 and 6 | H+8 → H+10 | 6c, 6h |
| 7 | Policies | Beat 7 | H+10 → H+11 | 6d |
| 8 | Guarantees, health, observability, control room, meters | Beats 1 and 5 | H+11 → H+14 | 6e, 6g |
| 9 | Statistics (S1, S2; S3 map if time) | Beat 8 | H+14 → H+16 | 6f |
| 10 | Quality gate + VPS deploy | Typecheck, lint, a11y pass, container on the VPS | H+16 → H+18 | Prompt 8 |
| 11 | Real backend switch-over | Each endpoint group moved from mock to real as it lands | continuous, H+5 → H+19 | Prompt 7 |
| 12 | Demo ready | 2 rehearsals, backup video recorded | H+19 → H+21.5 | Prompt 9 |

Scope cut for the window: P0 = everything in beats 1–8 except the S3 map and anomaly list (P1); trace
waterfall is P0 but may be a simple span table; English, phone layouts, browser notifications, audit export,
capacity view are P2.

## 13. Open questions

- [ ] **OQ-1** After a reload, can the browser reopen the selected file without asking the user again? If not,
  beat 2 includes one "re-select the file" click. (Upload engine, Prompt 2.)
- [ ] **OQ-2** Upload protocol: tus vs a custom chunk API. (Prompt 2, needs NestJS agreement.)
- [ ] **OQ-3** Who builds the meter simulator, and does it expose rate control through the API (BA-31)?
- [ ] **OQ-4** On a primary-storage outage, does NestJS write to the fallback or queue and retry? (Changes the
  copy in FE-08.)
- [ ] **OQ-5** Is `/api` routed by Traefik to NestJS on the same host? (Assumed in BA-00d; Prompt 2.)
- [ ] **OQ-6** Map granularity for faults: 3 regions or counties? Which counties does the seed data use?
- [ ] **OQ-7** Interpretation text: generated by the backend, or templated by the frontend from backend facts?
- [ ] **OQ-8** Auth transport and session length (cookie vs token; Prompt 2 threat model).
- [ ] **OQ-9** Live stream format (SSE vs WebSocket) and whether Traefik/Cloudflare keep it open long enough.
- [ ] **OQ-10** Venue network: real uplink speed, and whether we may use a phone hotspot as a fallback.
- [ ] **OQ-11** Corrupt-a-file: which storages can the backend corrupt in place (S3 object, FTP file, DB row)?
- [ ] **OQ-12** Thresholds for "În pericol" / "Încălcat" per guarantee: who defines them, and where are they
  configured?

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Venue network too slow/unstable for a live 1 GB upload | High | Beat 2 stalls | Beat 2 doesn't need completion; pre-uploaded drone video for beat 6; phone hotspot; backup video |
| 4 GB VPS runs out of memory during the storm + 1 GB upload | Medium | Pods killed mid-demo | Memory limits on every container; rehearse the exact script on the VPS; operation log writes batched (backend) |
| Backend contract late or different | High | Frontend blocked | Mock-first (D7, FE-18); OpenAPI proposal sent at H+1.5; per-endpoint switch-over; mock fallback on demo day |
| 22-hour window too short for all P0 | High | Beats missing at the demo | Time-boxed milestones (§12); cut S3 map, English, phone first; every milestone ends demoable on mocks |
| Reload-resume needs a file re-select (OQ-1) | Medium | Beat 2 less magical | Narrate it as a safety check ("verificăm că e același fișier") |
| Statistics look thin without history | Medium | Beat 8 weak | Seed run (BA-70) days before the demo |
| Storm makes the whole VPS slow, so "others stay flat" fails | Medium | N1 proof fails | Backend bulkheads per category; tune storm factor on the VPS; rehearse |
| Long-lived stream cut by Cloudflare/Traefik timeouts | Medium | Live counters freeze | Reconnect with backoff + visible "reconectare" state; decided in Prompt 2 |
| Demo controls exposed outside the demo | Low | Security finding | Demo mode off by default, admin-only, audited |

---
*Status: DRAFT: requirements only. Architecture and contract: Prompt 2. Implementation plan: Prompt 4.*
