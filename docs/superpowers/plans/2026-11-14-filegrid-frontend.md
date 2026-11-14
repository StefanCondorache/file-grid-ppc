# FileGrid PPC Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FileGrid PPC Next.js frontend in `frontend/` so that all eight demo beats of the PRD run
end-to-end on MSW mocks generated from the OpenAPI proposal, and switch to the real NestJS backend with one flag.

**Architecture:** Thin App Router shell (`(auth)` and `(app)` route groups); every screen is a client feature module
that reads server state through TanStack Query on same-origin `/api/v1`; a framework-free upload engine
(`src/lib/upload`) with a Zustand adapter; one SSE connection patches the query cache; MSW serves the whole contract
in the browser and in Vitest until `NEXT_PUBLIC_API_MOCKS=0`.

**Tech Stack:** Next.js (latest stable 16.x, App Router, `output: 'standalone'`), React 19, TypeScript strict,
Tailwind CSS v4 + shadcn/ui (Radix), TanStack Query, Zustand, react-hook-form + zod, openapi-typescript +
openapi-fetch, MSW v2 + `@mswjs/source` (OpenAPI baseline), Recharts, hash-wasm, idb, Vitest + Testing Library +
jsdom + fake-indexeddb, Playwright + @axe-core/playwright, Figtree via `next/font`.

**Spec:** [docs/frontend/prd.md](../../frontend/prd.md) (requirements),
[docs/frontend/context.md](../../frontend/context.md), [architecture docs](../../frontend/architecture/),
[ADRs 0001–0022](../../adr/README.md), [OpenAPI proposal](../../api/openapi.frontend-proposal.yaml),
[backend sync (provisional)](../../api/backend-sync-2026-11-14.md), [design](../../frontend/design/direction.md),
[tokens](../../frontend/design/tokens.css), [components](../../frontend/design/components.md),
[mockups](../../frontend/design/mockups/index.html).

## Global Constraints

- All UI copy Romanian with comma-below ș ț (U+0219/U+021B, U+0218/U+021A); never cedilla ş ţ (U+015F/U+0163). Code, identifiers, comments, commits English.
- No hex, `rgb()`, `hsl()` or named colours outside `src/styles/tokens.css`; components and charts use token variables / Tailwind theme names only.
- File bytes never pass through the Next.js server: no Route Handler, Server Action or rewrite proxies `/api` in production; downloads are `<a href={apiUrl(`/files/${id}/content`)} download>` or the streaming verifier.
- Read files only in `Blob.slice` chunks; never hold a whole file in memory.
- Mock switch: `NEXT_PUBLIC_API_MOCKS` = `1` (default in dev/test) | `0` (real backend); optional `NEXT_PUBLIC_API_MOCK_GROUPS` = comma list of groups to mock (default all). **Full mock** (all groups) uses the MSW service worker. **Hybrid** (some groups) uses no service worker: mocked groups are answered in-page through the API client's `fetch` (MSW `getResponse`) and a `MockEventSource`; `uploads` and `files` cannot be mocked in hybrid mode (they use XHR and plain links), so real uploads are never copied through a worker. Production build fails with mocks on unless `FILEGRID_ALLOW_MOCKS=1`.
- Allowed `NEXT_PUBLIC_*`: `NEXT_PUBLIC_API_MOCKS`, `NEXT_PUBLIC_API_MOCK_GROUPS`, `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_GRAFANA_URL`. Nothing secret.
- API base comes from `API_BASE` in `src/lib/api/base.ts` (`NEXT_PUBLIC_API_BASE`, default `/api/v1`; the NestJS skeleton uses `/api`). Never hard-code the prefix in handlers, stream URL, download hrefs or the ping probe. Endpoint groups: `auth, policies, uploads, files, audit, meters, monitoring, statistics, demo, stream`.
- Category ids `meter | fault | connection | drone`; storage labels `S3 | FTP | DB`; roles `teren | dispecerat | racordari | auditor | admin` (ADR-0022 login by role dropdown + password).
- Primary action colour `--fg-action` `#D04000` (white text 4.76:1); status never orange; status = 6 px-radius chip with icon + word; actions = pills.
- Font Figtree 400/600/700 via `next/font`; all numbers `tabular-nums`; Romanian numbers with NBSP (U+00A0) thousands and comma decimals: `1 024,5 MB`, `98,7 %`, `1,2 s`.
- Chunk size `clamp(policy.chunkSize, 5 MiB, 32 MiB)`, default 8 MiB; parallelism `clamp(policy.maxParallel, 1, 6)`, start at 2; backoff full jitter base 1 s cap 30 s, 10 attempts per part.
- Session: warning at T−2 min, "Rămân conectat" refresh; reveal of personal data expires after 60 s with a warning at 15 s.
- Footer text exactly `Prototip FileGrid · Hackathon PPC`; no PPC or Rețele Electrice logos.
- Container: standalone Node, `PORT=8080`, non-root, memory limit target 256Mi (P1 manifest currently 128Mi: raise it).
- Dependencies pinned to exact versions (`.npmrc` `save-exact=true`); `npm ci` only.
- Security rules SR-1..SR-23 in [threat-model.md](../../frontend/architecture/threat-model.md) apply to every task (no `dangerouslySetInnerHTML`, no tokens in storage, PII never in URLs/titles/logs/IndexedDB).

## Review Focus

1. **Reload with a different file of the same name/size** → resume must refuse ("Fișierul ales este diferit de cel început") instead of uploading mixed bytes. Pinned in Task 6b.9 (`rejects a reattached file whose sampled part hashes differ`).
2. **Session expires mid-upload, then a different user logs in on the same browser** → upload pauses, is not resumed for the other user, and resumes for the original user. Pinned in Task 6a.5 and Task 6b.10.
3. **Hostile file names** (RTL override, zero-width, 5 000 chars, `<img onerror>`) → rendered inert, isolated, truncated. Pinned in Task 5.12 (`SafeName`).
4. **Live stream silently stalls** (Cloudflare idle cut, no error event) → watchdog reconnects within 45 s and the cache is resynced, counters never freeze silently. Pinned in Task 6a.9.
5. **Zero-byte or over-policy files, wrong type** → rejected before any request with the reason in Romanian. Pinned in Task 6b.3.

---

## Parallel execution map

| Wave | Slices | Can run in parallel worktrees? |
|---|---|---|
| 1 | 5 Foundation | No: everything depends on it |
| 2 | 6a Shell+Auth | No: provides shell, auth, live stream, placeholders |
| 3 | 6b, 6c, 6d, 6e, 6f, **6h.1 Audit**, then 6g | Yes, each in its own worktree (`superpowers:using-git-worktrees`), branch `fe/<slice>`; 6g starts when 6e is merged |
| 4 | 6h.0 integration, 6h.2–6h.6 polish and deploy | No: touches all features; runs last |

**Merge order inside wave 3:** 6e → 6g (6g needs the scenario, `BulkheadChart`, `GuaranteeCard`, `StorageHealthStrip`); 6b → 6d e2e (beat 7 uploads a fault); 6c → 6g e2e (corrupt → download); 6c + 6e → 6f period test; 6c → 6h.1 (custody/audit links). Cross-slice effects are asserted once, after merging, in Task 6h.0.

**Rules that keep wave 3 conflict-free:** every runtime and dev dependency is installed in Task 5.1 (`package.json`/lockfile untouched afterwards); the OpenAPI YAML, `schema.d.ts`, `openapi.json` and `types.ts` aliases are final after Task 5.7; `StreamEvent` lives in `src/lib/live/events.ts` (Task 6a.8); all mock state lives in `src/mocks/db.ts` (Task 5.9b).

Shared files that cause merge conflicts in wave 3, and the rule that keeps them trivial:

| File | Touched by | Rule |
|---|---|---|
| `src/mocks/handlers/index.ts` | all | one import + one array entry per slice; append only |
| `src/lib/i18n/ro/index.ts` | all | one **namespaced** key per slice (`upload: upload`), never a spread (spreads silently overwrite colliding keys); strings live in `src/lib/i18n/ro/<feature>.ts` |
| `src/mocks/db.ts` | none after 5.9b | slices add collections only through `db.register(name, seed)` in their own seed file |
| `package.json`, lockfile, OpenAPI YAML, `schema.d.ts` | none after 5.1 / 5.7 | change them only in a dedicated commit on `frontend` main, then rebase worktrees |
| `src/mocks/seed/*.ts` | 6c, 6e, 6g | one seed file per group; 6a creates them empty |
| `src/mocks/scenario.ts` | 6e, 6g | 6e owns it; 6g only calls its exported actions (merge 6e before 6g, or 6g adds actions in `scenario-demo.ts`) |
| `src/lib/api/query-keys.ts` | none after 6a | 6a defines every key up front |
| `src/lib/live/bridge.ts` | none after 6a | 6a maps every event; slices only consume keys |
| `src/features/shell/AppShell.tsx` | none after 6a | chrome pieces are placeholder components owned by feature folders (`features/health/StorageHealthStrip.tsx`, `features/guarantees/AlertBanner.tsx`, `features/upload/UploadTray.tsx`) that slices replace in place |
| `src/components/charts/*` | 6e, 6f, 6g | primitives built in Foundation (Task 5.12); slices add new chart files only |
| `tests/e2e/demo.spec.ts` | all | one spec file per slice: `tests/e2e/<slice>.spec.ts` |

## Definition of done (every slice)

A slice is done only when all of these hold:

1. `npm run test` green (all Vitest suites) and the slice's Playwright spec green: `npm run e2e -- tests/e2e/<slice>.spec.ts`.
2. `npm run typecheck` clean.
3. `npm run lint` clean (ESLint incl. `jsx-a11y` strict + `react/no-danger`, `check-diacritics`, `check-colors`).
4. React review clean: run the `ecc:react-review` skill once per wave on the merged diff (per slice only if time allows); fix every blocking finding.
5. A11y checked: the slice's Playwright spec runs `expectNoAxeViolations(page)` on each new screen and state; manual keyboard pass through the slice's screens (Tab order, visible focus, Esc closes overlays).
6. Demo beat rehearsed on mocks: the beat(s) listed under the slice run from a fresh `npm run dev`, following the PRD §6 script, with the stopwatch time noted in `docs/frontend/rehearsal.md`.
7. `npm run build` succeeds with `NEXT_PUBLIC_API_MOCKS=0` (checked once per wave).
8. After each wave: redeploy to the VPS (Task 5.15 procedure) and open the deployed site over HTTPS.

**Task sizing rule:** tasks marked ⧉ contain several tests; run each `it(...)`/`test(...)` as its own red → green → commit cycle (2–5 min each). "Steps 2–4" always means: run the named test and watch it fail, implement exactly the signature in the task's **Interfaces** block, run it again and watch it pass.

**Time budget (one developer, ~14–16 h left):** the full P0 set is ~22 h. Already applied cuts: fixed upload concurrency (AIMD P1), no picker-streamed downloads (P1), static CSP (nonce P1), watchdog P1, colour/contrast gates P1, NVDA/Lighthouse/320 px P1–P2. If still behind after wave 3 starts, cut next: 6f.5 (S3 map, already P1), 6d.3 history (P1), 6c.4 meter table bars → plain list, 6h.3 states sweep.

Commands below run from `frontend/`. Priority tags: **P0** in the demo script or F-gate; **P1** makes it a winner;
**P2** only if time is left.

---

## Slice 5: Foundation (P0, ~1 h)

Demoable result: `npm run dev` shows a tokenised placeholder page with the "Date simulate" marker; `/healthz` answers
`ok`; tests, lint and typecheck run.

### Task 5.1: Scaffold Next.js app · P0

**Files:**
- Create: `frontend/` via `npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm` (it refuses a non-empty folder: move `frontend/CLAUDE.md` out first and back after), then install **every** dependency of the plan in one go with `--save-exact` (runtime: `@tanstack/react-query zustand react-hook-form @hookform/resolvers zod openapi-fetch recharts hash-wasm idb lucide-react class-variance-authority`; dev: `openapi-typescript yaml msw @mswjs/source vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event fake-indexeddb @playwright/test @axe-core/playwright eslint-plugin-jsx-a11y`), `frontend/.npmrc` (`save-exact=true`), `frontend/src/app/healthz/route.ts`
- Modify: `frontend/next.config.ts` (`output: 'standalone'`, `poweredByHeader: false`, `images: { unoptimized: true }`), `frontend/package.json` scripts
- Test: `frontend/src/app/healthz/route.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `start` (`next start -p ${PORT:-8080}` in standalone via `node .next/standalone/server.js`), `test` (`vitest run`), `test:watch`, `typecheck` (`tsc --noEmit`), `lint`, `e2e` (`playwright test`), `gen:api`, `verify` (`npm run typecheck && npm run lint && npm run test`).

- [ ] **Step 1: Write the failing test** `describe('GET /healthz')` → `it('returns 200 ok as text')`: `const res = await GET(); expect(res.status).toBe(200); expect(await res.text()).toBe('ok')`.
- [ ] **Step 2: Run** `npm i -D vitest@latest --save-exact` (minimal `vitest.config.mts`, node env; Task 5.2 completes it), then `npm run test -- src/app/healthz/route.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `export function GET(): Response` returning `new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })`.
- [ ] **Step 4: Run** the test → PASS; `npm run build` → succeeds.
- [ ] **Step 5: Commit** `git add frontend && git commit -m "feat(frontend): scaffold Next.js app with healthz"`

### Task 5.2: Vitest + Testing Library + format helpers · P0

**Files:**
- Create: `frontend/vitest.config.mts` (jsdom, `setupFiles: ['./src/test/setup.ts']`, alias `@`), `frontend/src/test/setup.ts` (`@testing-library/jest-dom/vitest`, `fake-indexeddb/auto`), `frontend/src/lib/i18n/format.ts`
- Test: `frontend/src/lib/i18n/format.test.ts`

**Interfaces:**
- Produces: `formatBytes(bytes: number): string`, `formatPercent(ratio: number, digits = 1): string`, `formatDuration(ms: number): string`, `formatInt(n: number): string`, `formatDateTime(iso: string): string` (Europe/Bucharest, `14.11.2026, 15:41`).

- [ ] **Step 1: Test** `it('formats numbers the Romanian way')`:
  ```ts
  expect(formatBytes(5_347_737)).toBe('5,1 MB');
  expect(formatBytes(1_320_702_444)).toBe('1,23 GB');
  expect(formatInt(1_284_532)).toBe('1 284 532');
  expect(formatPercent(0.987)).toBe('98,7 %');
  expect(formatDuration(1200)).toBe('1,2 s');
  expect(formatDuration(14)).toBe('14 ms');
  ```
- [ ] **Step 2: Run** `npm run test -- src/lib/i18n/format.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `Intl.NumberFormat('ro-RO')`, replacing the group separator with U+00A0; bytes base 1024 (`KB, MB, GB`), 2 decimals below 10 GB for GB, 1 decimal for MB; `formatDuration` uses ms below 1 000.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): vitest setup and Romanian formatters`

### Task 5.3: Lint gates · P0 (diacritics, security rules) / P1 (colour-literal check)

**Files:**
- Create: `frontend/scripts/check-diacritics.mjs`, `frontend/scripts/check-colors.mjs`
- Modify: `frontend/eslint.config.mjs` (add `jsx-a11y` strict, `react/no-danger: error`, `no-restricted-properties` for `innerHTML`/`insertAdjacentHTML`/`document.write`, `no-restricted-globals` for `localStorage`/`sessionStorage` except `src/mocks/**`), `package.json` `lint` = `eslint . && node scripts/check-diacritics.mjs && node scripts/check-colors.mjs`
- Test: `frontend/scripts/checks.test.ts`

**Interfaces:**
- Produces: `findCedillas(text: string): number[]` (indexes) and `findColorLiterals(css: string): string[]` exported from the scripts (ESM) and their CLIs that exit 1 with `file:line` lines.

- [ ] **Step 1: Test** `it('flags cedilla s/t but not comma-below')` → `findCedillas('Rețele \u015F')` equals `[7]` (write the cedilla as an escape so the test file itself passes the gate); `findCedillas('Rețele ș')` equals `[]`. `it('flags raw colours outside tokens')` → `findColorLiterals('a{color:#fff;background:rgb(0 0 0)}')` equals `['#fff','rgb(0 0 0)']`; `findColorLiterals('a{color:var(--fg-ink)}')` equals `[]`.
- [ ] **Step 2: Run** `npm run test -- scripts/checks.test.ts` → FAIL.
- [ ] **Step 3: Implement**: diacritics scans `src/**`, `tests/**` for U+015E/015F/0162/0163; colours scans `src/**/*.{ts,tsx,css}` except `src/styles/tokens.css` and `src/mocks/**` for `#[0-9a-fA-F]{3,8}\b`, `rgb\(`, `hsl\(`, `\b(red|blue|white|black)\b` inside `className`/style objects.
- [ ] **Step 4: Run** test → PASS; `npm run lint` → clean.
- [ ] **Step 5: Commit** `chore(frontend): lint gates for diacritics, colours and security rules`

### Task 5.4: Design tokens, Tailwind theme, Figtree · P0 (tokens, font) / P1 (contrast test)

**Files:**
- Create: `frontend/src/styles/tokens.css` (copy of `docs/frontend/design/tokens.css`, the single source after this), `frontend/src/styles/contrast.ts` (`contrastRatio(a: string, b: string): number`)
- Modify: `frontend/src/app/globals.css` (`@import "tailwindcss"; @import "../styles/tokens.css";` base body styles: `background: var(--fg-page); color: var(--fg-ink); font-variant-numeric: tabular-nums`), `frontend/src/app/layout.tsx` (`<html lang="ro">`, Figtree via `next/font/local` (OFL woff2 files for 400/600/700 committed in `src/styles/fonts/`, so Docker builds need no network) with `variable: '--font-figtree'`, `--fg-font-sans` set from it)
- Test: `frontend/src/styles/tokens.contrast.test.ts`

**Interfaces:**
- Produces: Tailwind utilities from `@theme inline` (`bg-primary`, `text-ink-2`, `rounded-pill`, `rounded-chip`, `shadow-e2`, `bg-ok`, `bg-cat-fault`, …) and the `[data-theme="dispecerat"]` theme.

- [ ] **Step 1: Test** `it('every functional pair meets WCAG AA')`, reading `tokens.css` and checking (light and dispecerat): `--fg-on-action` on `--fg-action` ≥ 4.5; `--fg-ink`, `--fg-ink-2`, `--fg-ink-3` on `--fg-surface` ≥ 4.5; `--fg-on-ok/-crit/-info` on their fills ≥ 4.5; `--fg-on-warn` on `--fg-warn` ≥ 4.5; `--fg-line-input` on `--fg-surface` ≥ 3; `--fg-cat-*` on `--fg-surface` ≥ 3. Also `expect(value('--fg-action')).toBe('#D04000')`.
- [ ] **Step 2: Run** `npm run test -- src/styles/tokens.contrast.test.ts` → FAIL (contrast.ts missing).
- [ ] **Step 3: Implement** `contrastRatio` (WCAG 2.x relative luminance) and a tiny parser that reads `--name: #hex;` per selector block.
- [ ] **Step 4: Run** → PASS; `npm run dev`, page text renders in Figtree (DevTools computed font).
- [ ] **Step 5: Commit** `feat(frontend): design tokens, Tailwind theme and Figtree`

### Task 5.5: i18n catalogue and announcer · P0

**Files:**
- Create: `frontend/src/lib/i18n/ro/index.ts` (`export const ro = { ...common, ...errors } as const`), `frontend/src/lib/i18n/ro/common.ts`, `frontend/src/lib/i18n/ro/errors.ts`, `frontend/src/lib/i18n/index.ts` (`useT()`, `plural()`, `Catalog` type), `frontend/src/lib/a11y/announcer.ts`, `frontend/src/components/a11y/Announcer.tsx`
- Test: `frontend/src/lib/i18n/plural.test.ts`, `frontend/src/lib/a11y/announcer.test.ts`

**Interfaces:**
- Produces: `useT(): Catalog`; `plural(n: number, forms: { one: string; few: string; other: string }): string`; `announce(message: string, priority?: 'polite' | 'assertive'): void` (dedupe identical messages within 2 s); `<Announcer />` renders two `aria-live` regions in the root layout.

- [ ] **Step 1: Tests** `it('uses the Romanian "de" plural')` → `plural(1,{one:'1 fișier',few:'# fișiere',other:'# de fișiere'})` = `'1 fișier'`, n=3 → `'3 fișiere'`, n=20 → `'20 de fișiere'`. `it('dedupes announcements within 2 s')` with fake timers: two `announce('x')` within 1 s → region text set once.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement** `plural` over `Intl.PluralRules('ro')` replacing `#` with `formatInt(n)`; announcer as a module store the component subscribes to.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): typed Romanian catalogue and live-region announcer`

### Task 5.6: shadcn/ui base primitives in PPC theme · P0 ⧉

**Files:**
- Create via `npx shadcn@latest init` (Tailwind v4, CSS variables) then `npx shadcn@latest add button badge card dialog alert-dialog dropdown-menu select tooltip switch table skeleton tabs collapsible`; theme them to tokens. Create `frontend/src/components/ui/status-chip.tsx`, `frontend/src/components/ui/tag.tsx`, `frontend/src/components/ui/icons.ts` (re-export Lucide icons used)
- Modify: `frontend/src/components/ui/button.tsx` variants
- Test: `frontend/src/components/ui/status-chip.test.tsx`, `frontend/src/components/ui/button.test.tsx`

**Interfaces:**
- Produces: `<Button variant="primary|secondary|quiet|danger" size="sm|md|lg">` (pill, `bg-primary` for primary); `<StatusChip tone="ok|warn|crit|info|neutral" icon label />` (6 px radius, icon `aria-hidden`, label is the accessible text); `<Tag>`.

- [ ] **Step 1: Tests** `it('renders the status word, not only colour')` → `render(<StatusChip tone="warn" label="În pericol" />)`; `getByText('În pericol')`; the svg has `aria-hidden="true"`; class contains `rounded-chip`. `it('primary button is a pill on the action colour')` → class contains `rounded-pill` and `bg-primary`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `class-variance-authority` (installed by shadcn). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): shadcn primitives themed to PPC tokens`

### Task 5.7: Generated API types · P0

**Files:**
- Modify first: `docs/api/openapi.frontend-proposal.yaml`: add `storageControl: boolean` to `DemoStatus` and `POST /demo/storages/{storage}` with body `{ up: boolean }` (returns `DemoStatus`). After this task no slice edits the YAML.
- Create: `frontend/scripts/gen-api.mjs` (runs `openapi-typescript ../docs/api/openapi.frontend-proposal.yaml -o src/lib/api/schema.d.ts` and writes `src/mocks/openapi.json` from the YAML with the `yaml` package), generated `frontend/src/lib/api/schema.d.ts`, `frontend/src/mocks/openapi.json`, `frontend/src/lib/api/types.ts` (named aliases: `Me`, `Policy`, `FileSummary`, `FileDetail`, `UploadSession`, `CompleteResult`, `GuaranteeStatus`, `Alert`, `StorageHealth`, `MetricsMatrix`, `BulkheadSeries`, `Trace`, `Category`, `Role`, `Capability`, `Zone`, `Origin`, `StorageLabel`, `IntegrityState`, `UploadStatus`, `PartReceipt`, `RevealResult`, `AuditEvent`, `MeterReading`, `MeterCounters`, `SimulatorStatus`, `Period`, `StorageFit`, `PeriodComparison`, `GridInsights`, `DemoStatus`, `CustodyEvent`, `PolicyUpdateRequest`: every alias any slice needs)
- Test: `frontend/src/lib/api/types.test-d.ts` (Vitest `expectTypeOf`)

- [ ] **Step 1: Test** `expectTypeOf<Category>().toEqualTypeOf<'meter' | 'fault' | 'connection' | 'drone'>()`; `expectTypeOf<Me['activeRole']>().toEqualTypeOf<Role>()`.
- [ ] **Step 2: Run** `npx vitest --typecheck --run src/lib/api/types.test-d.ts` → FAIL. **Step 3:** `npm run gen:api`; write aliases. **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(frontend): generate API types from the OpenAPI proposal`

### Task 5.8: API client and ApiError · P0

**Files:**
- Create: `frontend/src/lib/api/base.ts`, `frontend/src/lib/api/client.ts`, `frontend/src/lib/api/errors.ts`, `frontend/src/lib/api/csrf.ts`
- Test: `frontend/src/lib/api/client.test.ts`

**Interfaces:**
- Produces: `API_BASE` (`process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1'`) and `apiUrl(path: string): string`; `api` (openapi-fetch `createClient<paths>({ baseUrl: absoluteBase(), credentials: 'same-origin', fetch: apiFetch })` where `absoluteBase()` = `new URL(API_BASE, location.origin)` in the browser and `http://localhost${API_BASE}` in Vitest, because Node's `Request` rejects relative URLs; `apiFetch` is replaced by the in-page mock fetch in hybrid mode, Task 5.10); `class ApiError extends Error { status: number; code: string; fieldErrors: FieldError[]; traceId: string | null; retryAfterMs: number | null; details: unknown }`; `toApiError(res: Response, body: unknown): ApiError` that accepts **both** the proposal shape `{code,message,traceId,fieldErrors}` and the NestJS skeleton shape `{error:{code,message,trace_id,details}}` (backend-sync); `unwrap<T>(p: Promise<{data?: T; error?: unknown; response: Response}>): Promise<T>` throwing `ApiError`; `csrfHeaders(method: string): Record<string,string>` = `{ 'X-Requested-With': 'filegrid' }` for non-GET/HEAD.

- [ ] **Step 1: Tests** (msw/node): `it('adds X-Requested-With only to mutations')`; `it('normalises the proposal error shape')` → 422 with `fieldErrors` → `ApiError.code === 'VALIDATION_ERROR'`, `traceId` from body; `it('normalises the NestJS envelope')` → `{error:{code:'unauthorized',message:'x',trace_id:'t1'}}` → `code === 'UNAUTHORIZED'`, `traceId === 't1'`; `it('takes traceId from X-Trace-Id when the body has none')`; `it('maps network failure to NETWORK')`.
- [ ] **Step 2: Run** `npm run test -- src/lib/api/client.test.ts` → FAIL. **Step 3: Implement** (uppercase codes). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): typed API client with unified ApiError`

### Task 5.9: MSW baseline from OpenAPI and group handlers · P0

**Files:**
- Create: `frontend/src/mocks/handlers/index.ts` (`export const groupHandlers: Record<Group, RequestHandler[]>`; `export async function buildHandlers(groups: Group[] | 'all'): Promise<RequestHandler[]>` = hand-written group handlers first, then `await fromOpenApi(openapiJson)` baseline), `frontend/src/mocks/groups.ts` (`type Group`, `pathGroup(path: string): Group`), `frontend/src/mocks/node.ts` (`setupServer`), `frontend/src/mocks/browser.ts` (`setupWorker`), empty seeds `frontend/src/mocks/seed/{auth,files,monitoring,meters,statistics,demo,audit,policies}.ts`, `frontend/public/mockServiceWorker.js` (`npx msw init public --save`)
- Test: `frontend/src/mocks/handlers.test.ts`

**Interfaces:**
- Produces: `Group = 'auth'|'policies'|'uploads'|'files'|'audit'|'meters'|'monitoring'|'statistics'|'demo'|'stream'`; every endpoint in the proposal answers on mocks from day one (baseline), hand-written handlers override per group.

- [ ] **Step 1: Tests** `it('serves every proposal path from the baseline')` → `GET apiUrl('/statistics/periods')` returns 200 JSON; `it('hand-written handlers win over the baseline')` (register a group handler returning a marker, expect it); `it('pathGroup maps every path root')` → `/files/x/content`, `/traces/t` → files; `/stream` → stream; `/ping`, `/uploads/u/parts/1` → uploads; `/meter-readings`, `/meters/counters` → meters; `/guarantees`, `/alerts`, `/storage-health`, `/metrics/matrix` → monitoring; `/audit-events` → audit; `/statistics/periods` → statistics; `/demo/status`, `/demo/acting-role` → demo; `/auth/me` → auth (paths relative to `API_BASE`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; **time-box `@mswjs/source` to 20 min** (it is experimental, must handle the relative `servers: /api/v1`, pulls faker into the dev bundle and returns random enum values). Fallback: no baseline, hand-written handlers only, plus a last `http.all(apiUrl('/*'))` returning 501 `{ code: 'NOT_MOCKED' }`. Never let the baseline answer for a group that has hand-written handlers. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): MSW handlers with OpenAPI baseline`

### Task 5.9b: Shared mock database · P0

**Files:** Create `frontend/src/mocks/db.ts`; Test `frontend/src/mocks/db.test.ts`

**Interfaces:**
- Produces: `db` with collections `users, sessions, policies, uploads, files, custody, audit, periods, storage` (in memory, persisted to `localStorage['fg.mock.db']` so F5 keeps state); `db.register<T>(name: string, seed: T[]): void`; `db.files.insert(f)`, `db.audit.append(e: AuditEvent)`, `db.custody.append(fileId, e)`, `db.policies.get(category)`, `db.storage.status(name)`; `db.reset()` (also exposed as `window.__fgMockReset` in development). Every handler reads and writes through `db`, so cross-slice effects (policy → upload storage, corrupt → download 409, reveal → custody + audit, storm → periods, S3 down → fallback) work without slices importing each other. Policies are seeded here (fault v3 S3/FTP, drone v3 S3/FTP 8 MiB × 4, connection v2 DB encrypted, meter v1 DB) so `GET /policies` is deterministic from Foundation on.

- [ ] **Step 1: Tests** `it('persists across a simulated reload')`; `it('append-only audit keeps order')`; `it('reset restores seeds')`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): shared mock database`

### Task 5.10: Mock flag, production guard, "Date simulate" marker · P0

**Files:**
- Create: `frontend/src/lib/config/mocks.ts`, `frontend/src/app/MockBootstrap.tsx`, `frontend/src/components/MockMarker.tsx`, `frontend/src/lib/config/mock-guard.ts` (called from `frontend/next.config.ts` when `phase === PHASE_PRODUCTION_BUILD`, after `loadEnvConfig(process.cwd())` from `@next/env`, so `.env.local`/`.env.production` are honoured; `prebuild` scripts run without them), `frontend/src/mocks/in-page.ts` (hybrid mode: `mockFetch(handlers)` via MSW `getResponse`, `MockEventSource` fed by the scenario), `frontend/.env.example`, `frontend/.dockerignore` (`.env*` except `.env.example`)
- Modify: `docs/adr/0011-mock-api-msw.md` (status: amended — build-time `NEXT_PUBLIC_API_MOCKS` per user decision; demo-day fallback now needs a rebuild)
- Test: `frontend/src/lib/config/mocks.test.ts`, `frontend/src/lib/config/mock-guard.test.ts`

**Interfaces:**
- Produces: `mockConfig(env = process.env): { enabled: boolean; mode: 'off' | 'full' | 'hybrid'; groups: Group[] | 'all' }` (throws `uploads and files cannot be mocked in hybrid mode` when the list contains them but not every group) (`NEXT_PUBLIC_API_MOCKS` unset → enabled in `development`/`test`, disabled in `production`; `'0'` → disabled; `'1'` → enabled); `<MockBootstrap>` in `full` mode starts the worker with `buildHandlers('all')` before rendering children; in `hybrid` mode installs `mockFetch` into the API client and `MockEventSource` into the stream client, and registers **no** service worker; in every mode except `full` it unregisters stray service workers; `<MockMarker />` "Date simulate" chip listing mocked groups.

- [ ] **Step 1: Tests** truth table for `mockConfig`; `NEXT_PUBLIC_API_MOCK_GROUPS='auth,files'` → `['auth','files']`; guard: `checkMockGuard({ NEXT_PUBLIC_API_MOCKS: '1' }, 'production')` returns an error, with `FILEGRID_ALLOW_MOCKS: '1'` returns ok; `it('fails when .env.local sets NEXT_PUBLIC_API_MOCKS=1')` (temp dir with `.env.local`, `loadEnvConfig`); hybrid list `['statistics','uploads']` throws.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS; with `NEXT_PUBLIC_API_MOCKS=1` in `.env.local`, `npm run build` fails with the guard message.
- [ ] **Step 5: Commit** `feat(frontend): mock switch, production guard and marker`

### Task 5.11: Query client, providers, CSP proxy · P0

**Files:**
- Create: `frontend/src/lib/api/query-client.ts`, `frontend/src/app/providers.tsx`, `frontend/src/lib/security/csp.ts` (P0: static CSP sent from `next.config.ts` `headers()`; P1: per-request nonce in `frontend/src/proxy.ts`, Next 16's middleware name, CSP only, never auth)
- Modify: `frontend/next.config.ts` static `headers()` (nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP, X-Frame-Options) and dev-only `rewrites()` to `${API_DEV_PROXY_TARGET:-http://localhost:3001}`
- Test: `frontend/src/lib/api/query-client.test.ts`, `frontend/src/lib/security/csp.test.ts`

**Interfaces:**
- Produces: `makeQueryClient(): QueryClient` (staleTime 30 s, `refetchOnWindowFocus: false`, `retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2`); `buildCsp(opts: { nonce?: string; dev: boolean }): string` (no nonce → `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`, a residual risk recorded in threat-model §6 until the P1 nonce lands).

- [ ] **Step 1: Tests** `it('never retries 4xx, retries 5xx twice')`; `it('static CSP allows wasm and workers, never unsafe-eval')` → contains `'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `frame-ancestors 'none'`, `connect-src 'self'`, not `'unsafe-eval'`; dev adds `'unsafe-eval'`; (P1) `it('nonce CSP replaces unsafe-inline')` → `buildCsp({ nonce: 'abc', dev: false })` contains `'nonce-abc'` and `'strict-dynamic'`, not `'unsafe-inline'` in `script-src`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): query client, providers and CSP`

### Task 5.12: Shared display primitives · P0 ⧉

**Files:**
- Create: `frontend/src/components/SafeName.tsx` (+ `safeName.ts` pure function), `frontend/src/components/ErrorState.tsx`, `frontend/src/components/EmptyState.tsx`, `frontend/src/components/Forbidden.tsx`, `frontend/src/components/charts/ChartFigure.tsx`, `frontend/src/components/charts/ChartTable.tsx`, `frontend/src/components/charts/Sparkline.tsx`, `frontend/src/components/KpiTile.tsx`
- Test: `frontend/src/components/safeName.test.ts`, `frontend/src/components/ErrorState.test.tsx`, `frontend/src/components/charts/ChartFigure.test.tsx`

**Interfaces:**
- Produces: `cleanName(raw: string): { text: string; mixedScripts: boolean }` (NFC, strip C0/C1, bidi U+202A–202E/U+2066–2069/U+200E–200F, zero-width U+200B–200D/U+FEFF, cap 255); `<SafeName name>` (`dir="auto"`, `unicode-bidi: isolate`, ellipsis, full name in `title`, badge "caractere neobișnuite" when mixed scripts); `<ErrorState error={ApiError} onRetry? />` (Romanian message by code, "ID urmărire" + copy); `<ChartFigure title interpretation? data columns>{chart}</ChartFigure>` renders `<figure>`, chart with `role="img"`, `<details><summary>Vezi ca tabel</summary><ChartTable/></details>`.

- [ ] **Step 1: Tests** (Review Focus 3) `it('neutralises hostile names')`: `cleanName('‮txt.exe')` → text `'txt.exe'`; `cleanName('a'.repeat(5000)).text.length` = 255; `cleanName('Pаypal')` (Cyrillic а) → `mixedScripts: true`; render `<SafeName name="<img src=x onerror=alert(1)>" />` → no `img` element in the container. `it('shows code and trace ID')` for `ErrorState`. `it('chart has a table alternative from the same data')`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(frontend): SafeName, error/empty states and chart primitives`

### Task 5.13: Playwright + axe harness and container · P0

**Files:**
- Create: `frontend/playwright.config.ts` (webServer `npm run dev`, Chromium, `NEXT_PUBLIC_API_MOCKS=1`), `frontend/tests/e2e/helpers.ts` (`expectNoAxeViolations(page: Page, opts?)` using `@axe-core/playwright` with tags `wcag2a, wcag2aa, wcag21aa, wcag22aa`; `loginAs(page, role: Role)`), `frontend/tests/e2e/foundation.spec.ts`, `frontend/Dockerfile` (multi-stage `node:24-alpine`; runner `USER 101`, `ENV PORT=8080 HOSTNAME=0.0.0.0 NODE_OPTIONS=--max-old-space-size=160`, `CMD ["node","server.js"]`), `frontend/.dockerignore`
- Test: `tests/e2e/foundation.spec.ts`

- [ ] **Step 1: Test** `test('healthz and placeholder page are reachable and accessible')` → `GET /healthz` text `ok`; `/` shows "FileGrid" and the "Date simulate" marker; `expectNoAxeViolations(page)`.
- [ ] **Step 2: Run** `npm run e2e -- tests/e2e/foundation.spec.ts` → FAIL (no config). **Step 3: Implement**. **Step 4: Run** → PASS. If Docker is available: `docker build -t filegrid-frontend .` and `docker run -p 8080:8080 filegrid-frontend` → `curl localhost:8080/healthz` = `ok`.
- [ ] **Step 5: Commit** `chore(frontend): Playwright/axe harness and container image`

### Task 5.14: Demo-day matrix and fallbacks · P0

**Files:** Create `docs/frontend/demo-day-matrix.md`; Modify `frontend/package.json` (script `build:fullmock` = build with `NEXT_PUBLIC_API_MOCKS=1 FILEGRID_ALLOW_MOCKS=1`, image tag `filegrid-frontend:fullmock`)

- [ ] **Step 1:** Write the matrix: one row per endpoint group with columns *real backend ready?*, *mock*, *decision deadline* (H+14 for every group), *what the demo shows if mocked*. Record the backend-sync blockers that force mocks today (no operation-log spans, metrics, periods, origin tags, thresholds; auth is bearer-only, so SSE and plain downloads need the cookie or the polling fallback of Task 6a.10).
- [ ] **Step 2:** Document the two prebuilt images and the swap: `kubectl -n filegrid set image deploy/frontend frontend=filegrid-frontend:fullmock` (and back to `:real`), plus the rule that a hybrid build never mocks `uploads` or `files`.
- [ ] **Step 3:** Note in the matrix that in a full-mock fallback the health strip and guarantees do **not** react to a teammate's real `kubectl scale`; beat 5 then uses the control room's mocked "Oprește S3".
- [ ] **Step 4: Commit** `docs(frontend): demo-day mock/real matrix and fallback image`

### Task 5.15: Early VPS deploy · P0

**Files:** none new (uses `frontend/Dockerfile` and P1's `deploy/k8s/app/frontend/*`; propose the 256Mi limit and `PORT=8080` to P1, do not edit their files)

- [ ] **Step 1:** Build the image off-VPS, import into k3s, roll out; open `https://ppc.filegrid.cc.cd/healthz` → `ok` and `/` → placeholder with marker.
- [ ] **Step 2:** In the browser on the real domain check: no CSP violations in the console, `mockServiceWorker.js` registers only in full-mock images, `kubectl top pods -n filegrid` memory under the limit (if P1 keeps 128Mi, set `NODE_OPTIONS=--max-old-space-size=96`).
- [ ] **Step 3:** Write the exact deploy commands into `docs/frontend/demo-day-matrix.md` (reused after every wave). **Step 4: Commit** `docs(frontend): deploy procedure`

**Slice 5 demo check:** `npm run dev` → tokenised page with "Date simulate"; `npm run verify` green.

---

## Slice 6a: Shell + Auth (P0, ~1.5 h) — beat 1 (login, roles), beat 4 (role switch)

### Task 6a.1: Auth mock handlers and demo accounts · P0

**Files:**
- Create: `frontend/src/mocks/handlers/auth.ts`, `frontend/src/mocks/seed/auth.ts` (5 accounts `teren, dispecerat, racordari, auditor, admin`, mock password `demo-2026`, capabilities per FE-01 matrix), `frontend/src/mocks/session.ts` (mock session in `localStorage['fg.mock.session']` so reloads keep it; mocks are exempt from SR-3)
- Modify: `frontend/src/mocks/handlers/index.ts`
- Test: `frontend/src/mocks/handlers/auth.test.ts`

**Interfaces:**
- Produces: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/refresh`, `POST|DELETE /demo/acting-role` on mocks; `SEED_PASSWORD`; `mockSessionTtlMs` overridable via `localStorage['fg.mock'].sessionTtlMs` to rehearse expiry.

- [ ] **Step 1: Tests** `it('rejects a wrong password with INVALID_CREDENTIALS and no field hint')`; `it('me returns capabilities for the role')` → `racordari` has `view_connection` but not `reveal_pii`; `auditor` has `reveal_pii`; `admin` has `demo_controls` but not `reveal_pii`; `it('acting role switches activeRole but keeps realUser')`; `it('every role switch appends a role_switch audit event')` (via `db.audit`); `/demo/acting-role` handlers live in `auth.ts` but are registered under the `demo` group.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS. **Step 5: Commit** `feat(mocks): auth handlers and five demo accounts`

### Task 6a.2: Capabilities and safe redirects · P0

**Files:**
- Create: `frontend/src/lib/auth/capabilities.ts`, `frontend/src/lib/auth/safe-next.ts`
- Test: `frontend/src/lib/auth/capabilities.test.ts`, `frontend/src/lib/auth/safe-next.test.ts`

**Interfaces:**
- Produces: `can(me: Me | undefined, cap: Capability): boolean` (uses `me.capabilities`; `FALLBACK_MATRIX` only when the array is empty); `safeNext(next: string | null): string`.

- [ ] **Step 1: Tests** table of FE-01 rows; `safeNext('/files?category=fault')` → same; `safeNext('//evil.example')`, `safeNext('https://evil.example')`, `safeNext('/\\evil')`, `safeNext(null)` → `'/'`.
- [ ] **Steps 2–4:** run → FAIL, implement, run → PASS. **Step 5: Commit** `feat(auth): capabilities and safe redirect`

### Task 6a.3: Login screen with role dropdown (ADR-0022) · P0

**Files:**
- Create: `frontend/src/app/(auth)/layout.tsx`, `frontend/src/app/(auth)/login/page.tsx`, `frontend/src/features/auth/LoginForm.tsx`, `frontend/src/features/auth/queries.ts` (`useMe`, `useLogin`, `useLogout`, `useRefresh`), `frontend/src/features/auth/schemas.ts`, `frontend/src/lib/i18n/ro/auth.ts`
- Test: `frontend/src/features/auth/LoginForm.test.tsx`

**Interfaces:**
- Produces: `ROLE_OPTIONS: { role: Role; label: string; hint: string }[]` in the order Echipă de teren, Dispecerat, Angajat racordări, Auditor, Administrator; login posts `{ username: role, password }`.

- [ ] **Step 1: Tests** `it('lists the five roles in Romanian')`; `it('submits the chosen role as username')` (msw spy); `it('shows one generic error, never which field')` → text `Rol sau parolă greșită.`; password input has `autocomplete="current-password"`; `it('redirects to safeNext(next) after login')`; `it('shows the expired notice when reason=expired')` → `Sesiunea a expirat. Intră din nou în cont.`
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(auth): role-dropdown login`

### Task 6a.4: Query keys and app store · P0

**Files:**
- Create: `frontend/src/lib/api/query-keys.ts` (full factory from frontend-architecture §3 for every slice), `frontend/src/stores/app-store.ts`
- Test: `frontend/src/lib/api/query-keys.test.ts`

**Interfaces:**
- Produces: `type AppLiveStatus = 'connecting' | 'open' | { reconnectingInS: number } | 'offline'`; `qk` (`me, files.list(f), files.detail(id), files.custody(id), traces.one(id), policies.all, policies.history(c), guarantees, alerts, health, metrics.matrix(w), metrics.bulkhead(w), stats.periods, stats.s1(p), stats.s2(a,b), stats.s3(p), meters.counters, meters.readings(f), meters.simulator, audit(f), demo.status`); `useAppStore` `{ live: AppLiveStatus; lastEventAt: number|null; livePaused: boolean; setLive(); setLivePaused() }`.

- [ ] **Step 1: Test** `it('keys are stable and hierarchical')` → `qk.files.list({category:'fault'})[0] === 'files'`; same input → deep-equal key. **Steps 2–4.** **Step 5: Commit** `feat(frontend): query keys and app store`

### Task 6a.5: Session expiry and clearClientState · P0

**Files:**
- Create: `frontend/src/lib/auth/session.ts`, `frontend/src/lib/auth/clear-client-state.ts`, `frontend/src/features/auth/SessionExpiryDialog.tsx`, `frontend/src/lib/upload/engine-port.ts` (`UploadControl` interface + no-op default, replaced in 6b)
- Test: `frontend/src/lib/auth/session.test.ts`, `frontend/src/lib/auth/clear-client-state.test.ts`

**Interfaces:**
- Produces: `UploadControl` = `{ pauseAll(reason: 'session'|'logout'): void; resumeAll(ownerUserId: string): void; restoreAndResume(userId: string): Promise<void> }` (no-op default here, real engine in 6b.9); `scheduleSession(me: Me, now: number, handlers: { onWarn(): void; onExpire(): void }): () => void` (skew = `serverTime − now`; warns 120 s before the earlier of `expiresAt`/`idleExpiresAt`); `clearClientState(deps: { queryClient; closeStream(); uploads: UploadControl; broadcast?: BroadcastChannel }, reason: 'logout'|'session'|'401'): void`.

- [ ] **Step 1: Tests** (fake timers) `it('warns two minutes before expiry, corrected for clock skew')`; `it('expiry pauses uploads and redirects with next')`; (Review Focus 2) `it('on logout pauses uploads but never deletes upload records')` → `uploads.pauseAll` called with `'logout'`, IndexedDB store untouched; `it('broadcasts logout to other tabs')`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(auth): session expiry warning and client-state wipe`

### Task 6a.6: App shell, sidebar, top bar, footer, placeholders · P0 ⧉

**Files:**
- Create: `frontend/src/app/(app)/layout.tsx`, `frontend/src/app/(app)/page.tsx` (temporary heading "Garanții de business"), `frontend/src/app/(app)/error.tsx`, `frontend/src/features/shell/{AppShell,Sidebar,TopBar,Footer,AuthGate,nav}.tsx|ts`, `frontend/src/components/Wordmark.tsx` (3×3 chunk grid, brand-orange last two cells), placeholders returning `null`: `frontend/src/features/shell/LivePauseSwitch.tsx`, `frontend/src/features/health/StorageHealthStrip.tsx`, `frontend/src/features/guarantees/AlertBanner.tsx`, `frontend/src/features/upload/UploadTray.tsx`, `frontend/src/lib/i18n/ro/shell.ts`
- Test: `frontend/src/features/shell/AppShell.test.tsx`

**Interfaces:**
- Produces: `NAV: { href: string; label: string; icon: IconName; cap?: Capability; group: 'Monitorizare'|'Fișiere'|'Administrare'|'Demo' }[]`; `AuthGate` redirects to `/login?next=` on 401 and calls `uploads.restoreAndResume(me.realUser.id)` whenever `me.realUser.id` changes (wires resume after re-login; 6b never edits the shell).

- [ ] **Step 1: Tests** `it('hides Politici and Cameră de control for teren')`; `it('marks the current page with aria-current')`; `it('renders the exact footer text')` → `Prototip FileGrid · Hackathon PPC`; `it('has a skip link to main')`; `it('shows "Rol activ: Auditor"')`; `it('shows no demo-only nav, switcher or marker when demoMode is false')` (FE-14); `it('AuthGate restores uploads for the real user after login')` (spy on `UploadControl.restoreAndResume`).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(shell): app shell with gated navigation`

### Task 6a.7: Header role switcher (demo mode) · P0

**Files:**
- Create: `frontend/src/features/auth/RoleSwitcher.tsx`
- Test: `frontend/src/features/auth/RoleSwitcher.test.tsx`

**Interfaces:**
- Consumes: `POST /demo/acting-role`, `qk.me`, `reconnect()` of the stream handle exposed by `LiveBridge` (Task 6a.10). Implement this task after 6a.10.
- Produces: rendered only when `me.demoMode`; options = `ROLE_OPTIONS`; on select: `setQueryData(qk.me, newMe)`, `queryClient.resetQueries({ predicate: q => q.queryKey[0] !== qk.me[0] })` (keeps the `me` just set), clears any revealed personal data, `liveBridge.reconnect()`, `announce('Rol activ: …')`.

- [ ] **Step 1: Tests** `it('is absent when demo mode is off')`; `it('switching keeps uploads and resets other queries')` (UploadControl spy not called); radio semantics (`menuitemradio`, `aria-checked`).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(auth): demo role switcher`

### Task 6a.8: SSE mock stream and scenario clock · P0

**Files:**
- Create: `frontend/src/lib/live/events.ts` (`StreamEvent` type, imported by production code and mocks), `frontend/src/mocks/handlers/stream.ts` (MSW `sse(apiUrl('/stream'))`; in hybrid mode the same events go to `MockEventSource`; emits `ping` every 20 s, forwards scenario events; `?mockDrop=1` closes every 30 s), `frontend/src/mocks/scenario.ts` (event emitter + `tick()`; 6e extends state)
- Test: `frontend/src/mocks/handlers/stream.test.ts`

**Interfaces:**
- Produces: `scenario.emit(event: StreamEvent)`, `scenario.on(listener)`; `StreamEvent` (in `src/lib/live/events.ts`) `= { type: 'ping'|'meters.counters'|'guarantees.status'|'alert.raised'|'alert.updated'|'storage.health'|'file.created'|'file.integrity'|'upload.verified'|'policy.updated'|'simulator.status'|'demo.storm'; id: number; data: unknown }`.

- [ ] **Step 1: Test** the scenario emitter in Node, not an EventSource: `it('emits ping with monotonic ids')`, `it('delivers emitted events to every listener')`. The MSW `sse()` wiring (needs a recent msw and a browser) is checked by the 6a e2e. **Steps 2–4.** **Step 5: Commit** `feat(mocks): SSE stream and scenario clock`

### Task 6a.9: Live stream client · P0 (reconnect, backoff, session check) / P1 (45 s watchdog)

**Files:**
- Create: `frontend/src/lib/live/stream.ts`
- Test: `frontend/src/lib/live/stream.test.ts`

**Interfaces:**
- Produces: `connectStream(opts: { url: string; onEvent(e: StreamEvent): void; onOpen(): void; onStatus(s: AppLiveStatus): void; checkSession(): Promise<'ok'|'expired'>; EventSourceImpl?: typeof EventSource }): { close(): void; reconnect(): void }`; watchdog 45 s; manual backoff `1,2,4,8,16,30 s` ±30 % jitter after `readyState === CLOSED`; `online` event → immediate reconnect.

- [ ] **Step 1: Tests** with a fake EventSource and fake timers: (Review Focus 4) `it('reconnects when no event arrives for 45 s, even without an error event')`; `it('calls onOpen after every reconnect so the cache can resync')`; `it('stops retrying and reports expired when the session check fails')`; `it('backs off 1, 2, 4… up to 30 s')`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(live): SSE client with watchdog and backoff`

### Task 6a.10: Cache bridge and LiveBridge · P0

**Files:**
- Create: `frontend/src/lib/live/bridge.ts`, `frontend/src/features/shell/LiveBridge.tsx`, `frontend/src/features/shell/LiveStatusPill.tsx`
- Test: `frontend/src/lib/live/bridge.test.ts`

**Interfaces:**
- Produces: `applyEvent(qc: QueryClient, e: StreamEvent, deps: { announce; uploadHint(uploadId: string): void; paused: boolean }): void` mapping every event per frontend-architecture §4 (snapshots → `setQueryData`; `file.created` → throttled invalidate ≤ 1/s + `announce('Avarie nouă: {zone}, {substation}')` coalesced per 5 s; `upload.verified` → `uploadHint`); `resync(qc)` invalidates all stream-fed keys; when `paused`, events are buffered and the latest snapshot applied on resume. `LiveBridge` has `mode: 'sse' | 'poll'`: `poll` (chosen when the stream returns 401/404 or the backend is bearer-only) refetches every stream-fed key every 3 s, so the board still moves without SSE.

- [ ] **Step 1: Tests** one per event type; `it('resyncs every stream-fed key on open')`; `it('coalesces fault announcements during a storm')` (10 events in 5 s → 1 announcement "10 avarii noi"); `it('buffers while paused')`; `it('falls back to polling when the stream is unavailable')`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(live): stream-to-cache bridge`

### Task 6a.11: Slice e2e · P0

**Files:** Test: `frontend/tests/e2e/6a-shell-auth.spec.ts`

- [ ] **Step 1: Test** `test('beat 1: log in as admin and land on Garanții')`; `test('beat 4 prerequisite: switch to racordari then auditor without logging out')`; `test('session expiry warning appears and Rămân conectat extends it')` (mock TTL 3 min); axe on `/login`, `/` (light) and with `data-theme="dispecerat"`.
- [ ] **Step 2–4:** run → FAIL → fix → PASS. **Step 5: Commit** `test(e2e): shell and auth`

**Slice 6a done when:** DoD + beat 1 opening (login over HTTPS on mocks, role pill) and a role switch rehearsed.

---

## Slice 6b: Upload engine (P0, ~3 h) — beats 2 and 3 · worktree `fe/6b-upload`

Owns: `src/lib/upload/**`, `src/features/upload/**`, `src/mocks/handlers/uploads.ts`, `src/lib/i18n/ro/upload.ts`.

### Task 6b.1: State machine · P0

**Files:** Create `frontend/src/lib/upload/types.ts`, `frontend/src/lib/upload/machine.ts`; Test `frontend/src/lib/upload/machine.test.ts`

**Interfaces:**
- Produces: `type UploadState = 'queued'|'hashing'|'uploading'|'paused'|'connection_lost'|'verifying'|'verified'|'failed'|'needs_file'`; `type PauseReason = 'user'|'offline'|'session'|'logout'`; `type FailReason = 'forbidden'|'upload_gone'|'too_large'|'policy_violation'|'file_changed'|'different_file'|'checksum_mismatch'|'retries_exhausted'`; `transition(s: UploadState, e: UploadEvent): UploadState`; `stateLabel: Record<UploadState, string>` in `ro/upload.ts` = în așteptare · se calculează amprenta · se încarcă · în pauză · conexiune pierdută · se verifică · verificat · eșuat · alege din nou fișierul.

- [ ] **Step 1: Test** table-driven over every row of upload-engine.md §11 plus ignored impossible events; `it('a restored record never starts in uploading')`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): state machine`

### Task 6b.2: Backoff · P0

**Files:** Create `frontend/src/lib/upload/backoff.ts`; Test `frontend/src/lib/upload/backoff.test.ts`

**Interfaces:** `backoffMs(attempt: number, rng: () => number, base = 1000, cap = 30000): number` (full jitter).

- [ ] **Step 1: Test** 1 000 seeded draws within `[0, min(cap, base·2^n)]`; cap respected at attempt 10; deterministic with fixed rng.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): full-jitter backoff`

### Task 6b.3: Chunk plan and policy pre-validation · P0

**Files:** Create `frontend/src/lib/upload/plan.ts`; Test `frontend/src/lib/upload/plan.test.ts`

**Interfaces:** `clampChunkSize(requested: number, fileSize: number): number` (5–32 MiB, raised so parts ≤ 10 000); `planParts(size: number, chunkSize: number): { n: number; start: number; end: number }[]` (1-based n); `validateFile(file: { size: number; type: string; name: string }, p: PolicySnapshot): string[]` (Romanian reasons).

- [ ] **Step 1: Tests** `clampChunkSize(1 MiB, 10 MiB)` = 5 MiB; `clampChunkSize(64 MiB, 1 GiB)` = 32 MiB; last part shorter; (Review Focus 5) `validateFile` → 0 bytes → `['Fișierul este gol.']`; over max → `['Fișierul depășește 4 GB, limita politicii.']`; wrong type → `['Tipul video/avi nu este permis pentru această categorie.']`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): chunk plan and policy pre-validation`

### Task 6b.4: Hashing (worker) · P0

**Files:** Create `frontend/src/lib/upload/hash-core.ts`, `frontend/src/lib/upload/hash.worker.ts`, `frontend/src/lib/upload/hasher.ts`; Test `frontend/src/lib/upload/hash-core.test.ts` (`// @vitest-environment node`, jsdom lacks a complete `crypto.subtle`/`Blob.arrayBuffer`)

**Interfaces:** `hashBlob(blob: Blob, chunkSize: number, onProgress: (hashedBytes: number) => void, signal?: AbortSignal): Promise<{ sha256: string; partHashes: string[] }>` (hash-wasm `createSHA256` incremental over `blob.slice`; per part `crypto.subtle.digest('SHA-256')`); `hasher.hash(file, chunkSize, onProgress)` runs it in `hash.worker.ts` via `new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' })`.

- [ ] **Step 1: Tests** `hashBlob(new Blob(['abc']), 5 MiB)` → `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`; 3-part random 12 MiB blob with 5 MiB chunks → `partHashes` equal Node `crypto` digests of each slice and whole hash equals Node's; abort rejects.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): incremental SHA-256 in a worker`

### Task 6b.5: Persistence and PII allow-list · P0

**Files:** Create `frontend/src/lib/upload/repo.ts` (idb store `filegrid-uploads` v1), `frontend/src/lib/upload/pii.ts`; Test `frontend/src/lib/upload/repo.test.ts`

**Interfaces:** `PersistedUpload` per upload-engine.md §8.1; `createRepo(): { put(r): Promise<void>; get(localId): Promise<PersistedUpload|undefined>; listFor(userId: string): Promise<PersistedUpload[]>; markPart(localId, n): Promise<void>; remove(localId): Promise<void>; purgeOlderThan(ms: number): Promise<number> }`; `toPersistable(input, category): PersistedUpload` (drops `applicantName`, `cnp`, `address`; for `connection` no `fileName`, no handle).

- [ ] **Step 1: Tests** (fake-indexeddb) round trip; `it('never stores personal data')` → connection record JSON has no `cnp`, `applicantName`, `fileName`, `handle` (use plain-object handle stubs; fake-indexeddb cannot clone real file-system handles); `listFor('u2')` excludes `u1` records; purge removes > 24 h.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): IndexedDB repo with PII allow-list`

### Task 6b.6: Network monitor · P0 (`navigator.onLine` + failure heuristic) / P1 (probe)

**Files:** Create `frontend/src/lib/upload/net.ts`; Test `frontend/src/lib/upload/net.test.ts`

**Interfaces:** `createNetMonitor(deps: { win: Window; probe(): Promise<boolean>; rng; clock }): NetMonitor` (`online`, `subscribe`, `reportNetworkError`, `reportSuccess`); probe = `HEAD apiUrl('/ping')` (no-store, 3 s timeout).

- [ ] **Step 1: Tests** `offline` event → `online=false` at once; `online` event alone does not resume until the probe succeeds; two network errors within 5 s → suspect offline.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): network monitor with probe`

### Task 6b.7: Upload API port and mock protocol · P0

**Files:** Create `frontend/src/lib/upload/api.ts` (fetch for JSON, XHR `PartTransport` with progress, 30 s stall / 120 s total abort), `frontend/src/mocks/handlers/uploads.ts` (state in `localStorage['fg.mock.uploads']` so F5 keeps "server" state; never stores bodies; every uploads and ping handler returns `HttpResponse.error()` when `!navigator.onLine || fg.mock.offline`, because the service worker otherwise keeps answering while the browser is offline; `fg.mock` flags `failRate`, `offline`, `expire401Once`, `corruptPart`, `completeMismatch`, `slowComplete`, `bps`); Test `frontend/src/mocks/handlers/uploads.test.ts`, `frontend/src/lib/upload/api.test.ts`

**Interfaces:** `UploadApi { create(req, idempotencyKey): Promise<UploadSession>; status(id): Promise<UploadStatus>; complete(id, sha256, partCount): Promise<CompleteResult | { status: 'verifying'; retryAfterS: number }>; cancel(id): Promise<void> }`; `PartTransport.send({ uploadId, partNumber, body, sha256Hex, signal, onProgress }): Promise<PartReceipt>` throwing `ApiError`.

- [ ] **Step 1: Tests** create idempotent on same key (second returns `Idempotent-Replayed: true`); same part twice → `alreadyReceived: true`; wrong `X-Part-SHA256` → 422 `PART_CHECKSUM_MISMATCH`; complete with a missing part → 409 `PARTS_MISSING` with `missingRanges`; `it('fails like a network error when offline')`; the policy comes from `db.policies`; `completeMismatch` → 200 `verdict: 'mismatch'`, `fileId: null`; fault complete has `availableAfterMs`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): API port and mock chunk protocol`

### Task 6b.8: Scheduler · P0 ⧉

**Files:** Create `frontend/src/lib/upload/scheduler.ts`; Test `frontend/src/lib/upload/scheduler.test.ts`

**Interfaces:** `createScheduler(deps: { transport: PartTransport; net: NetMonitor; repo; clock; rng; onPart(n): void; onState(e: UploadEvent): void }): { start(u: ActiveUpload): void; pause(reason): void; abort(): void }` — **P0:** fixed concurrency = `clamp(policy.maxParallel, 1, 6)`; **P1:** AIMD (start 2, +1 after 4 consecutive successes, halve on retryable failure); status classes per upload-engine.md §6.

- [ ] **Step 1: Tests** concurrency never exceeds ceiling; `it('confirms each part exactly once under random failures')` (20 seeds at P0, 200 at P1); 401 → `paused('session')` and in-flight aborted without counting attempts; 409 `UPLOAD_NOT_OPEN` → reconciles via `status()`; 422 checksum retried 3× then `failed('file_changed')`; 10 attempts → `failed('retries_exhausted')` still resumable; 429 honours `Retry-After`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): adaptive parallel scheduler`

### Task 6b.9: Engine facade, progress and store · P0 ⧉

**Files:** Create `frontend/src/lib/upload/engine.ts`, `frontend/src/lib/upload/progress.ts`, `frontend/src/lib/upload/store.ts`; Modify `frontend/src/lib/upload/engine-port.ts` (export the real engine as `UploadControl`); Test `frontend/src/lib/upload/engine.test.ts`, `frontend/src/lib/upload/progress.test.ts`

**Interfaces:** `uploadEngine` implements `UploadControl` (6a.5) and `{ enqueue({ file, category, metadata, handle? }): string; pause(id); resume(id); cancel(id); reattach(id, file): Promise<void>; pauseAll(reason); resumeAll(ownerUserId); restore(userId): Promise<void> }`; `useUploadStore(selector)` with `items: Record<string, UploadItemView>` (fields per frontend-architecture §3); snapshots coalesced to 4 Hz; `speedEma(prev, instant)` α 0.2; ETA hidden for the first 3 s.

- [ ] **Step 1: Tests** enqueue → hashing → uploading → verifying → verified with fake ports; mismatch → `failed('checksum_mismatch')` and no `fileId`; (Review Focus 1) `it('rejects a reattached file whose sampled part hashes differ')` → state `failed('different_file')`, message `Fișierul ales este diferit de cel început.`; store updates at most 4 per second.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): engine facade and throttled store`

### Task 6b.10: Resume after reload · P0

**Files:** Create `frontend/src/lib/upload/file-handle.ts`; Modify `frontend/src/lib/upload/engine.ts` (`restore`); Test `frontend/src/lib/upload/restore.test.ts`

**Interfaces:** `captureHandle(item: DataTransferItem): Promise<FileSystemFileHandle | null>` (`getAsFileSystemHandle`); `reopen(handle): Promise<File | 'needs_permission' | null>` (`queryPermission` then `requestPermission` on user gesture).

- [ ] **Step 1: Tests** restore with a granted handle → resumes, only missing parts sent (server `receivedRanges` merged with local bitset); without handle → `needs_file`; (Review Focus 2) `it('does not resume another user’s upload')` → `restore('u2')` leaves `u1` records paused and hidden; connection category always `needs_file`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): resume after reload`

### Task 6b.11: Upload screen · P0 ⧉ (one cycle each: schemas + CNP, ChunkGrid, Dropzone, screen assembly)

**Files:** Create `frontend/src/app/(app)/upload/page.tsx`, `frontend/src/features/upload/{UploadScreen,CategoryPicker,MetadataForm,Dropzone,UploadQueue,ChunkGrid,PolicySummary}.tsx`, `frontend/src/features/upload/schemas.ts`; Test `frontend/src/features/upload/schemas.test.ts`, `frontend/src/features/upload/ChunkGrid.test.tsx`, `frontend/src/features/upload/Dropzone.test.tsx`

**Interfaces:** `faultMetadataSchema`, `connectionMetadataSchema` (CNP 13 digits + checksum), `droneMetadataSchema`, each `satisfies` the generated request types; `cnpIsValid(cnp: string): boolean`; `ChunkGrid({ parts, confirmed, inFlight, failed })` ≤ 256 cells (each cell = ⌈parts/256⌉ parts).

- [ ] **Step 1: Tests** `cnpIsValid('1960101410019')` per the official checksum (pick a valid fixture and one with a wrong control digit); `it('chunk grid exposes Romanian progress text')` → `aria-valuetext` = `58 %, 712 MB din 1,23 GB` (with NBSP); `it('dropzone has a real "Alege fișiere" button')`; CNP input has `autocomplete="off"`, `inputmode="numeric"`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): upload screen with chunk grid`

### Task 6b.12: Upload tray and announcements · P0

**Files:** Modify `frontend/src/features/upload/UploadTray.tsx` (replace placeholder); Create `frontend/src/features/upload/announce.ts`; Test `frontend/src/features/upload/announce.test.ts`, `frontend/src/features/upload/UploadTray.test.tsx`

**Interfaces:** `uploadAnnouncements(prev: UploadItemView, next: UploadItemView): { text: string; priority: 'polite'|'assertive' } | null` (state changes always; 25/50/75/100 %; `connection_lost` once per outage; failures assertive).

- [ ] **Step 1: Tests** no announcement for 26→27 %; 49→50 % announces; `failed` assertive; tray collapses with Esc and shows "1 în curs · 1 verificat"; shows "pornit ca Echipă de teren"; (FE-08) a completed upload with `usedFallback` shows `Scris pe rezervă: FTP`; `503 STORAGE_UNAVAILABLE` shows `S3 nu este disponibil. Celelalte categorii funcționează normal. Reîncercăm automat.`
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(upload): tray and live-region announcements`

### Task 6b.13: Slice e2e (beats 2–3) · P0

**Files:** Test `frontend/tests/e2e/6b-upload.spec.ts`

- [ ] **Step 1: Tests** `test('beat 2 on mocks: offline, online, reload resumes')` (write a 60 MB file to `testInfo.outputPath('drone.mp4')` and pass the **path** to `setInputFiles`, since buffers are capped at 50 MB; `fg.mock.bps` low, `context.setOffline(true/false)`, `page.reload()`, scripted re-select after reload because Playwright has no file-system handle, percent never decreases, reaches "Verificat"); `test('beat 3: fault record shows "Disponibil pentru dispecerat în"')`; `test('session expires mid-upload, re-login as the same role resumes')` (`fg.mock.expire401Once`); axe on `/upload` idle, uploading and failed states.
- [ ] **Steps 2–4.** **Step 5: Commit** `test(e2e): upload beats 2 and 3`

**Slice 6b done when:** DoD + beats 2 and 3 rehearsed on mocks; memory flatness noted as "real backend only" (MSW reads parts).

---

## Slice 6c: Files + Integrity + Trace (P0, ~2 h) — beats 3, 4, 6 · worktree `fe/6c-files`

Owns: `src/features/files/**`, `src/features/integrity/**`, `src/lib/integrity/**`, `src/app/(app)/files/**`, `src/app/(app)/traces/**`, `src/mocks/handlers/files.ts`, `src/mocks/seed/files.ts`, `src/lib/i18n/ro/files.ts`.

### Task 6c.1: Files mock handlers and seed · P0

**Files:** Create `frontend/src/mocks/handlers/files.ts`; Modify `frontend/src/mocks/seed/files.ts` (≥ 40 files across 4 categories, 3 zones, origins, one corrupt, one on fallback FTP, connection docs with masked fields); Test `frontend/src/mocks/handlers/files.test.ts`

- [ ] **Step 1: Tests** filters (`category`, `zone`, `from/to`, `q` never matches name/CNP, `excludeGenerated`), sort `-createdAt`, `meta.total/hasMore`; `racordari` sees connection docs masked; `teren` gets 404 for a connection doc; reveal as `racordari` → 403, as `auditor` → 200 with `expiresAt` 60 s ahead.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): files, traces, custody, reveal`

### Task 6c.2: Filters in the URL and files table · P0 ⧉

**Files:** Create `frontend/src/app/(app)/files/page.tsx`, `frontend/src/features/files/{FilesScreen,FiltersBar,FilesTable,IntegrityBadge,SeverityLevel,OriginTag}.tsx`, `frontend/src/features/files/filters.ts`, `frontend/src/features/files/queries.ts`; Test `frontend/src/features/files/filters.test.ts`, `frontend/src/features/files/FilesTable.test.tsx`

**Interfaces:** `parseFilters(sp: URLSearchParams): FileFilters`; `toSearchParams(f: FileFilters): URLSearchParams`; `IntegrityBadge({ state })` → Verificat / Verificat de server / Neverificat / Fișier corupt detectat.

- [ ] **Step 1: Tests** round trip of filters; invalid values dropped; table renders `SafeName`, storage tag, severity as level bars (not status colour), "Criptat în repaus" for connection; empty state "Niciun fișier pentru aceste filtre" with "Resetează filtrele"; error state shows trace ID; filters uploader, integrity and storage and sort by size round-trip through the URL; pagination shows `Afișate 1–25 din 128`; rows written to the fallback show `FTP · rezervă` (FE-08).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(files): filters and files table`

### Task 6c.3: Live fault list · P0

**Files:** Modify `frontend/src/features/files/FilesTable.tsx` (new-row wash, focus preserved); Test `frontend/src/features/files/live.test.tsx`

- [ ] **Step 1: Test** emit `file.created` (fault) on the mock stream → new row appears on top within 1 s without moving keyboard focus; row has "Nou · acum 4 s".
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(files): live fault list`

### Task 6c.4: Meter readings table · P0

**Files:** Create `frontend/src/features/files/MeterReadingsTable.tsx`; Test `frontend/src/features/files/MeterReadingsTable.test.tsx`

- [ ] **Step 1: Test** `/files?category=meter` renders meter id, zone, reading time, kWh, sequence; row links to `/files/{fileId}`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(files): meter readings view`

### Task 6c.5: File detail with integrity and storage panels · P0 ⧉

**Files:** Create `frontend/src/app/(app)/files/[fileId]/page.tsx`, `frontend/src/features/files/{FileDetailScreen,HashPair,StoragePolicyPanel,PiiField}.tsx`; Test `frontend/src/features/files/FileDetail.test.tsx`

- [ ] **Step 1: Tests** both hashes shown with first/last 8 chars emphasised and "Amprentele coincid…" when equal; storage shown as label only (no URL-like text: assert none of `s3://`, `ftp://`, `http`); masked PII reads "mascat" to screen readers; page `<title>` never contains PII.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(files): file detail`

### Task 6c.6: Trace waterfall and trace route · P0 (simple table) / P1 (bars)

**Files:** Create `frontend/src/features/integrity/TraceWaterfall.tsx`, `frontend/src/app/(app)/traces/[traceId]/page.tsx`; Test `frontend/src/features/integrity/TraceWaterfall.test.tsx`

- [ ] **Step 1: Tests** `it('is embedded in the file detail for uploadTraceId')` (FE-05, add it under "Trasarea operației" in `FileDetailScreen`); renders a `<table>` with columns Pas, Storage, Început, Durată; bar left/width = `startOffsetMs/total`, `durationMs/total`; error span has text "eroare" and crimson bar; copy trace ID button; Grafana link only when `NEXT_PUBLIC_GRAFANA_URL` is set.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(integrity): trace waterfall`

### Task 6c.7: Chain of custody · P0

**Files:** Create `frontend/src/features/integrity/CustodyTimeline.tsx`; Test `frontend/src/features/integrity/CustodyTimeline.test.tsx`

- [ ] **Step 1: Test** ordered list newest first; `pii_revealed` shows actor, "Rol demo" when `actingAs`, and reason.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(integrity): chain of custody`

### Task 6c.8: Download and verify · P0

**Files:** Create `frontend/src/lib/integrity/verify.ts`, `frontend/src/features/integrity/DownloadButton.tsx`; Test `frontend/src/lib/integrity/verify.test.ts` (`// @vitest-environment node`)

**Interfaces:** `downloadAndVerify({ fileId, size, expectedSha256, onProgress, signal, saveFile? }): Promise<VerifiedDownloadResult>` — ≤ 64 MiB buffered then saved via anchor; > 64 MiB: **P0** server verification; **P1** `showSaveFilePicker` streamed with a client hash; otherwise anchor download and `POST /files/{id}/verification` → "Verificat de server"; `409 FILE_CORRUPT` → corrupt result with both hashes, the storage, the trace ID and the next step (`Restaurează din rezervă` when a fallback copy exists, else `Anunță echipa de storage`) (FE-04).

- [ ] **Step 1: Tests** matching bytes → `Verificat`; one flipped byte → `Fișier corupt detectat` with expected and actual hashes; 409 body mapped; > 64 MiB without picker → mode `server_verified`; Blob URL revoked.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(integrity): download with re-verification`

### Task 6c.9: Reveal personal data (auditor) · P0

**Files:** Create `frontend/src/features/files/RevealDialog.tsx`, `frontend/src/features/files/useReveal.ts`; Test `frontend/src/features/files/RevealDialog.test.tsx`

**Interfaces:** `useReveal(fileId)` → `{ reveal(reason): Promise<void>; values: RevealResult | null; secondsLeft: number; extend(): Promise<void> }` with `gcTime: 0`, cleared on unmount/navigation/role switch.

- [ ] **Step 1: Tests** reason < 10 chars blocked with message; after reveal, values shown and auto-hidden at 60 s; warning "se ascunde în 15 s" + "Prelungește"; button disabled with tooltip for `racordari`; values never in `document.title` or the URL.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(files): audited time-boxed reveal`

### Task 6c.10: Slice e2e (beats 3, 4, 6) · P0

**Files:** Test `frontend/tests/e2e/6c-files.spec.ts`

- [ ] **Step 1: Tests** beat 3 fault pops into the list; beat 4 racordari sees masks and cannot reveal, auditor reveals with reason and the event appears in custody; beat 6 verified download then corrupt file shows "Fișier corupt detectat"; axe on list, detail, dialog.
- [ ] **Steps 2–4.** **Step 5: Commit** `test(e2e): files, integrity and trace`

---

## Slice 6d: Policies (P0, ~1 h) — beat 7 · worktree `fe/6d-policies`

Owns: `src/features/policies/**`, `src/app/(app)/policies/**`, `src/mocks/handlers/policies.ts`, `src/mocks/seed/policies.ts`, `src/lib/i18n/ro/policies.ts`.

### Task 6d.1: Policy mocks · P0

**Files:** Create `frontend/src/mocks/handlers/policies.ts`; Modify `frontend/src/mocks/seed/policies.ts` (fault v3 S3/FTP; drone v3 S3/FTP 8 MiB × 4; connection v2 DB encrypted locked; meter v1 DB); Test `frontend/src/mocks/handlers/policies.test.ts`

- [ ] **Step 1: Tests** PUT with stale `baseVersion` → 409 with `currentPolicy`; success bumps version and emits `policy.updated`; non-admin → 403; the new version is written to `db.policies` (its effect on uploads is asserted in 6h.0).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): policies with versions and conflicts`

### Task 6d.2: Policy schema and diff · P0

**Files:** Create `frontend/src/features/policies/schema.ts`, `frontend/src/features/policies/diff.ts`; Test `frontend/src/features/policies/schema.test.ts`

**Interfaces:** `policySchema` (fallback ≠ primary, chunk 5–32 MiB, parallel 1–6, encryption forced for `connection`); `diffPolicy(a: Policy, b: PolicyUpdate): { field: string; from: string; to: string }[]` with Romanian field labels.

- [ ] **Step 1: Tests** fallback equal to primary → error `Rezerva trebuie să fie diferită de storage-ul principal.`; chunk 40 MiB → error; diff lists only changed fields.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(policies): schema and diff`

### Task 6d.3: Policy screens · P0 (edit) / P1 (history)

**Files:** Create `frontend/src/app/(app)/policies/page.tsx`, `frontend/src/app/(app)/policies/[category]/page.tsx`, `frontend/src/features/policies/{PoliciesScreen,PolicyForm,DiffDialog,ConflictNotice,VersionHistory}.tsx`; Test `frontend/src/features/policies/PolicyForm.test.tsx`

- [ ] **Step 1: Tests** auditor sees read-only; admin save shows diff then confirm then "Salvat · versiunea v4"; 409 shows the other person's change and the new diff; note "Încărcările în curs păstrează politica de la pornire".
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(policies): edit with diff, confirm and conflict`

### Task 6d.4: Slice e2e (beat 7) · P0

**Files:** Test `frontend/tests/e2e/6d-policies.spec.ts`

- [ ] **Step 1: Test** change faults primary S3 → FTP, confirm, upload a fault (requires 6b; skip with `test.skip` until merged), detail shows "Stocat pe FTP · politica v4"; axe on form and dialog.
- [ ] **Steps 2–4.** **Step 5: Commit** `test(e2e): policies beat 7`

---

## Slice 6e: Business guarantees + Observability (P0 board/matrix, P1 history) — beats 1, 5 · worktree `fe/6e-monitoring`

Owns: `src/features/guarantees/**`, `src/features/health/**`, `src/features/observability/**`, `src/app/(app)/page.tsx`, `src/app/(app)/observability/**`, `src/mocks/handlers/monitoring.ts`, `src/mocks/seed/monitoring.ts`, `src/mocks/scenario.ts` (state), `src/lib/i18n/ro/monitoring.ts`.

### Task 6e.1: Monitoring mocks and scenario state · P0 ⧉

**Files:** Create `frontend/src/mocks/handlers/monitoring.ts`; Modify `frontend/src/mocks/scenario.ts` (state: counters, per-category p95 series, storage status, storms; actions `startStorm(category, factor, durationS)`, `stopStorm(category)`, `setStorage(name, up)`, `corrupt(fileId)`, `setSimulator(mode)`; exposed as `window.__fgScenario` in development for e2e and rehearsal), `frontend/src/mocks/seed/monitoring.ts`; Test `frontend/src/mocks/scenario.test.ts`

- [ ] **Step 1: Tests** storm on faults raises fault p95 above 2 s within 3 ticks while others stay under 1 s; guarantee `fault` becomes `at_risk` and `alert.raised` is emitted; S3 down → `storage.health` S3 `down` and `db.storage` updated (the fallback effect on uploads is asserted in 6h.0); `lost` stays 0 always.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): monitoring scenario`

### Task 6e.2: Guarantees board · P0

**Files:** Modify `frontend/src/app/(app)/page.tsx`; Create `frontend/src/features/guarantees/{GuaranteesBoard,GuaranteeCard,MeterCounters}.tsx`, `frontend/src/features/guarantees/sentences.ts`; Test `frontend/src/features/guarantees/GuaranteeCard.test.tsx`

**Interfaces:** `sentenceFor(g: GuaranteeStatus): string` (e.g. `Avariile ajung la dispecerat în 3,4 s, peste ținta de 2 s.`).

- [ ] **Step 1: Tests** each state renders text + icon + chip ("OK", "În pericol", "Încălcat"); at-risk card has the 6 px status edge; status change announced politely, `violated` assertively; counters render as label/number rows with `pierdute (trebuie 0)`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(guarantees): business guarantees board`

### Task 6e.3: Storage health strip, alert banner, alerts list · P0

**Files:** Modify `frontend/src/features/health/StorageHealthStrip.tsx`, `frontend/src/features/guarantees/AlertBanner.tsx` (replace placeholders); Create `frontend/src/features/guarantees/AlertsList.tsx`; Test `frontend/src/features/health/StorageHealthStrip.test.tsx`, `frontend/src/features/guarantees/AlertBanner.test.tsx`

- [ ] **Step 1: Tests** strip shows `Postgres · S3 · FTP` with word + latency; S3 down → "S3 căzut" chip with icon; banner appears only when a guarantee is not OK, reserved height (no layout shift: container keeps `grid-template-rows`), text names the guarantee and cause, "Vezi detalii" links to `/`; acknowledge records who/when.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(health): storage strip and alert banner`

### Task 6e.4: Category × storage matrix · P0

**Files:** Create `frontend/src/app/(app)/observability/page.tsx`, `frontend/src/features/observability/{ObservabilityScreen,MetricsMatrix,WindowSelect}.tsx`; Test `frontend/src/features/observability/MetricsMatrix.test.tsx`

- [ ] **Step 1: Tests** real `<table>` 4 rows × 3 storage columns with p50/p95/p99, throughput, error rate; empty cell says "fără trafic"; polling 5 s stops when "Actualizări live" is paused or the tab is hidden; `keepPreviousData` (no flash on refresh).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(observability): category × storage matrix`

### Task 6e.5: Bulkhead chart · P0

**Files:** Create `frontend/src/features/observability/BulkheadChart.tsx` (Recharts via `next/dynamic`); Test `frontend/src/features/observability/BulkheadChart.test.tsx`

- [ ] **Step 1: Tests** 4 series with token colours and distinct `strokeDasharray`; direct end labels "Avarii 3,4 s"; threshold line labelled "țintă avarii 2 s"; one y-axis; table alternative contains every point; tooltips text-only.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(observability): bulkhead chart with table`

### Task 6e.6: "Actualizări live" pause · P0

**Files:** Modify `frontend/src/features/shell/LivePauseSwitch.tsx` (replace the 6a placeholder; `TopBar.tsx` is not touched); Test `frontend/src/features/shell/LivePauseSwitch.test.tsx`

- [ ] **Step 1: Tests** toggling sets `livePaused`; counters stop updating; resuming applies the latest snapshot; state announced.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(a11y): pause live updates`

### Task 6e.7: Slice e2e (beats 1, 5) · P0

**Files:** Test `frontend/tests/e2e/6e-monitoring.spec.ts`

- [ ] **Step 1: Tests** beat 1: 4 green cards, health strip, counters ticking; beat 5 (drive the scenario through `window.__fgScenario`): faults card "În pericol", banner, S3 red then green, other categories flat in the matrix; axe in light and `dispecerat` themes.
- [ ] **Steps 2–4.** **Step 5: Commit** `test(e2e): guarantees and observability`

---

## Slice 6f: Statistics (P0 S1/S2, P1 S3) — beat 8 · worktree `fe/6f-statistics`

Owns: `src/features/statistics/**`, `src/app/(app)/statistics/**`, `src/mocks/handlers/statistics.ts`, `src/mocks/seed/statistics.ts`, `src/lib/i18n/ro/statistics.ts`, `src/components/charts/RegionMap.tsx`.

### Task 6f.1: Statistics mocks · P0

**Files:** Create `frontend/src/mocks/handlers/statistics.ts`; Modify `frontend/src/mocks/seed/statistics.ts` (periods: "Zi normală · 12 nov", "Furtună · 14 nov 15:33"; S1/S2/S3 facts); Test `frontend/src/mocks/handlers/statistics.test.ts`

- [ ] **Step 1: Tests** default comparison = last normal vs most recent peak; periods are read from `db.periods` (storm → new peak period is asserted in 6h.0); `excludeGenerated` changes totals.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): statistics periods and facts`

### Task 6f.2: Interpretation templates (OQ-7) · P0

**Files:** Create `frontend/src/features/statistics/interpret.ts`; Test `frontend/src/features/statistics/interpret.test.ts`

**Interfaces:** `interpretS1(item): { text: string; recommendation: string }`, `interpretS2(cmp)`, `interpretS3(insights)`; uses backend `text` when present, otherwise templates from `facts`.

- [ ] **Step 1: Tests** fault S3 0,6 s vs FTP 1,8 s → `Avariile se scriu de 3× mai repede pe S3 decât pe FTP…`; backend text wins when present; numbers formatted Romanian.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(statistics): interpretation templates`

### Task 6f.3: S1 storage fit · P0

**Files:** Create `frontend/src/app/(app)/statistics/page.tsx`, `frontend/src/features/statistics/{StatisticsScreen,StorageFit,PeriodPicker}.tsx`; Test `frontend/src/features/statistics/StorageFit.test.tsx`

- [ ] **Step 1: Tests** small multiples per category, storages as axis labels (no storage colours), "Recomandat: S3" tag, interpretation + recommendation blocks, table view.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(statistics): S1 storage fit`

### Task 6f.4: S2 normal vs peak · P0

**Files:** Create `frontend/src/features/statistics/PeriodComparison.tsx`; Test `frontend/src/features/statistics/PeriodComparison.test.tsx`

- [ ] **Step 1: Tests** dumbbell per category (hollow = normal, filled = peak), drawn axis 0–4 s, delta "+467 %", table view; changing periods refetches `qk.stats.s2(a,b)`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(statistics): S2 normal vs peak`

### Task 6f.5: S3 grid insights · P1

**Files:** Create `frontend/src/components/charts/RegionMap.tsx`, `frontend/src/features/statistics/GridInsights.tsx`; Test `frontend/src/features/statistics/GridInsights.test.tsx`

- [ ] **Step 1: Tests** 3 region paths with sequential tokens and count labels, "Hartă schematică, nu la scară", anomalies table wraps, table alternative.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(statistics): S3 map and anomalies`

### Task 6f.6: Slice e2e (beat 8) · P0

**Files:** Test `frontend/tests/e2e/6f-statistics.spec.ts`

- [ ] **Step 1: Tests** `test('beat 8: S1 and S2 show interpretation and recommendation')`; `test('each chart opens its table')`; axe on `/statistics`.
- [ ] **Step 2: Run** `npm run e2e -- tests/e2e/6f-statistics.spec.ts` → FAIL. **Step 3:** fix. **Step 4:** → PASS. **Step 5: Commit** `test(e2e): statistics beat 8`

---

## Slice 6g: Demo control room + Meter live view (P0) — beats 5, 6 · worktree `fe/6g-demo` (start after 6e is merged: needs the scenario, `BulkheadChart`, `GuaranteeCard`, `StorageHealthStrip`)

Owns: `src/features/demo/**`, `src/features/meters/**`, `src/app/(app)/demo/**`, `src/app/(app)/meters/**`, `src/mocks/handlers/{demo,meters}.ts`, `src/mocks/seed/{demo,meters}.ts`, `src/lib/i18n/ro/{demo,meters}.ts`. Calls `scenario.ts` actions from 6e (or adds `src/mocks/scenario-demo.ts` if 6e is not merged yet).

### Task 6g.1: Demo and meter mocks · P0

**Files:** Create `frontend/src/mocks/handlers/demo.ts`, `frontend/src/mocks/handlers/meters.ts`; Test `frontend/src/mocks/handlers/demo.test.ts`

- [ ] **Step 1: Tests** demo endpoints 404 when demo mode off; storm factor > 20 → 422; corruption makes the file's next download return 409 `FILE_CORRUPT`; simulator `peak` raises `ratePerS`; every action creates an audit event.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(mocks): demo controls and meters`

### Task 6g.2: Control room · P0 ⧉

**Files:** Create `frontend/src/app/(app)/demo/page.tsx`, `frontend/src/features/demo/{ControlRoom,StormControl,StorageControl,CorruptControl,SimulatorControl,TerminalHelp,EffectPanel}.tsx`; Test `frontend/src/features/demo/ControlRoom.test.tsx`

**Interfaces:** `StorageControl` shows Pornește/Oprește buttons only when the API exposes storage control (`me.capabilities` contains `demo_controls` and `GET /demo/status` has `storageControl: true`); otherwise `TerminalHelp` shows copy-paste `make chaos-storage-stop S=s3` / `make chaos-storage-start S=s3`.

- [ ] **Step 1: Tests** route forbidden for non-admin or demo off; every action opens an AlertDialog with focus on "Anulează"; storm countdown text `01:12` with `aria-hidden` timer and on-demand announce; danger actions use crimson-outline pills, only "Pornește" uses the orange primary; `it('shows the same-screen effect panel')` → `EffectPanel` embeds `BulkheadChart`, the four `GuaranteeCard`s and `StorageHealthStrip` (FE-12).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(demo): control room`

### Task 6g.3: Meter live view · P0

**Files:** Create `frontend/src/app/(app)/meters/page.tsx`, `frontend/src/features/meters/{MetersScreen,RateKpi,ZoneSplit,RecentReadings}.tsx`; Test `frontend/src/features/meters/MetersScreen.test.tsx`

- [ ] **Step 1: Tests** counters not in a live region; "Citește rezumatul" announces `1 284 532 primite, 0 pierdute`; simulator control visible to admin only; recent readings link to file detail.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(meters): live meter view`

### Task 6g.4: Slice e2e (beats 5, 6) · P0

**Files:** Test `frontend/tests/e2e/6g-demo.spec.ts`

- [ ] **Step 1: Tests** `test('beat 5: storm on faults turns the faults card În pericol while others stay OK')`; `test('beat 5: stopping S3 turns the strip red and back')`; `test('beat 6: corrupt a file, its download shows Fișier corupt detectat')` (needs 6c merged); axe in the `dispecerat` theme.
- [ ] **Step 2: Run** `npm run e2e -- tests/e2e/6g-demo.spec.ts` → FAIL. **Step 3:** fix. **Step 4:** → PASS. **Step 5: Commit** `test(e2e): control room beats 5 and 6`

---

## Slice 6h: Audit + i18n polish (P0 audit, P1 polish, P2 English) — beat 4 end, all beats

6h.1 (audit) runs **in wave 3** in its own worktree `fe/6h-audit` because beat 4 ends on the audit trail; 6h.0 and 6h.2–6h.6 run after wave 3 merges. Owns: `src/features/audit/**`, `src/app/(app)/audit/**`, `src/mocks/handlers/audit.ts`, `src/lib/i18n/en/**`, `docs/frontend/rehearsal.md`.

### Task 6h.0: Cross-slice integration on mocks · P0

**Files:** Test `frontend/tests/e2e/6h-integration.spec.ts`

- [ ] **Step 1: Tests** `test('policy change routes the next fault upload to FTP')` (6d + 6b + 6c); `test('S3 down makes fault uploads land on the fallback with the badge')` (6e + 6b + 6c); `test('a storm creates a peak period offered in S2')` (6e + 6f); `test('reveal appears in custody and in the audit trail')` (6c + 6h.1); `test('role switch appears in the audit trail')` (6a + 6h.1).
- [ ] **Step 2: Run** `npm run e2e -- tests/e2e/6h-integration.spec.ts` → FAIL where wiring through `db` is missing. **Step 3:** fix in the owning handler. **Step 4:** → PASS. **Step 5: Commit** `test(e2e): cross-slice integration`

### Task 6h.1: Audit trail · P0 · wave 3, worktree `fe/6h-audit`

**Files:** Create `frontend/src/mocks/handlers/audit.ts` (reads `db.audit`), `frontend/src/app/(app)/audit/page.tsx`, `frontend/src/features/audit/{AuditScreen,AuditTable,AuditFilters}.tsx`; Test `frontend/src/features/audit/AuditTable.test.tsx`

- [ ] **Step 1: Tests** columns cine / ce / când / motiv / ID urmărire; filters in URL; reveal and role-switch events show "Rol demo" when `actingAs`; forbidden for `teren`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(audit): audit trail`

### Task 6h.2: Catalogue completeness and English · P1 (parity) / P2 (English)

**Files:** Create `frontend/src/lib/i18n/catalog.test.ts`, `frontend/src/lib/i18n/en/index.ts` (P2)

- [ ] **Step 1: Test** no hard-coded Romanian strings in components (grep for `[ăâîșț]` in `src/features/**/*.tsx` outside `ro/` returns nothing); if `en` exists it `satisfies Catalog`.
- [ ] **Steps 2–4.** **Step 5: Commit** `chore(i18n): catalogue completeness`

### Task 6h.3: States sweep and page titles · P1

**Files:** Modify each `src/app/(app)/**/page.tsx` `metadata.title` (`<Pagina> · FileGrid`); Test `frontend/tests/e2e/6h-states.spec.ts`

- [ ] **Step 1: Tests** every route shows loading skeleton, empty, error (forced via `fg.mock` flag) with trace ID, and the Forbidden view for a lacking role; titles never contain PII.
- [ ] **Steps 2–4.** **Step 5: Commit** `fix(ui): consistent states and titles`

### Task 6h.4: Full accessibility pass · P0 (axe on all routes, keyboard path) / P1 (NVDA, Lighthouse) / P2 (320 px reflow)

**Files:** Test `frontend/tests/e2e/6h-a11y.spec.ts`

- [ ] **Step 1: Tests** axe on every route in both themes; 320 px viewport has no horizontal scroll on main content; `prefers-reduced-motion` disables the chunk breathe; keyboard-only path through beats 1–8 (Tab/Enter/Esc) recorded in the spec.
- [ ] **Steps 2–4:** fix findings. Manual: NVDA pass over 8 beats, Lighthouse a11y ≥ 95 on `/`, `/upload`, `/files`, `/statistics`. **Step 5: Commit** `fix(a11y): full pass`

### Task 6h.5: Real backend switch-over check · P0

**Files:** Create `frontend/tests/e2e/6h-real-backend.spec.ts` (tagged `@real`, skipped unless `E2E_REAL=1`)

- [ ] **Step 1: Test** with `NEXT_PUBLIC_API_MOCKS=0` against the team's backend: login, `me`, one list, one upload of 3 MB; error envelope mapped (either shape).
- [ ] **Steps 2–4:** run when an endpoint group lands; switch that group off in `NEXT_PUBLIC_API_MOCK_GROUPS`. **Step 5: Commit** `test(e2e): real backend smoke`

### Task 6h.6: Rehearsal checklist and VPS deploy · P0

**Files:** Create `docs/frontend/rehearsal.md` (FE-14 checklist: accounts, demo mode on, seed loaded, pre-uploaded drone video, simulator normal, DevTools ready, teammate terminal ready, backup video, Chrome Task Manager, timings per beat; plus: fresh login ≤ 10 min before the demo and idle TTL ≥ 30 min checked in `/auth/me` so the T−2 dialog cannot appear mid-demo; phone hotspot ready; the polling-fallback switch for SSE; `NODE_OPTIONS=--max-old-space-size=96` if P1 keeps 128Mi; the fallback-image swap command from Task 5.14; unregister any service worker left on the VPS domain from mock rehearsals)

- [ ] **Step 1:** `npm run build` with `NEXT_PUBLIC_API_MOCKS=0`; build image off-VPS; deploy per P1's `deploy/k8s/app/frontend/` (ask P1 to raise the limit to 256Mi); `kubectl top pods -n filegrid` < 256Mi during beat 2.
- [ ] **Step 2:** two full rehearsals; record times; record the backup video. **Step 3: Commit** `docs(frontend): rehearsal checklist`
