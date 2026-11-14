# FileGrid PPC: frontend architecture

*Status: DRAFT (2026-11-14), Prompt 2. Author: ecc:architect agent. Inputs: [context.md](../context.md),
[prd.md](../prd.md), `frontend/CLAUDE.md`, `deploy/k8s/*`. Upload engine internals: [upload-engine.md](upload-engine.md).
Threat model: [threat-model.md](threat-model.md). Accessibility: [accessibility.md](accessibility.md). Decisions FA-*
are recorded as ADRs in [docs/adr/](../../adr/README.md); where an ADR differs from this document, the ADR wins.*

*Reconciled with the other agents (details in the ADRs): API base is `/api/v1` (ADR-0002); a CSP-only middleware
exists (ADR-0012), still no auth middleware; chunk size 5–32 MiB, default 8 MiB (ADR-0005); upload completion is
200 or 202 + poll, with an SSE hint (ADR-0003); stored-hash header is `X-File-SHA256` (ADR-0014).*

**Guiding constraint:** one developer, 22 hours, a 4 GB VPS. Each choice below is the simplest one that still
proves the brief live. Dependency budget: `next`, `react`, `react-dom`, `@tanstack/react-query`, `zustand`,
`react-hook-form`, `zod`, `@hookform/resolvers`, `openapi-fetch`, `msw`, `recharts`. Dev only: `typescript`,
`openapi-typescript`, `eslint`, `vitest`, `@playwright/test`, `@axe-core/playwright`. The upload engine adds
`hash-wasm` (ADR-0004); accessibility adds Radix UI primitives (ADR-0019). Every colour comes from
`src/styles/tokens.css`.

---

## 1. App Router structure

Latest stable Next.js (16.x at scaffold time, exact version pinned), React 19, TypeScript `strict` plus
`noUncheckedIndexedAccess`. Route segments are **English** (file names are English per `CLAUDE.md`); all visible
text is Romanian.

### Routes

| Screen | Route | Group | Roles (UI gate; the backend enforces) |
|---|---|---|---|
| SC-01 Autentificare | `/login?next=…&reason=expired` | `(auth)` | public |
| SC-02 Garanții de business | `/` | `(app)` | all |
| SC-03 Încărcare | `/upload?category=…` | `(app)` | teren, dispecerat, racordari, admin |
| SC-04 Fișiere | `/files?category=&zone=&from=&to=&q=&page=` | `(app)` | per category |
| SC-04 (meter readings) | `/files?category=meter` renders the readings table variant | `(app)` | dispecerat, auditor, admin |
| SC-05 Detaliu fișier | `/files/[fileId]` (meter readings too) | `(app)` | per category |
| SC-05 trace | `/traces/[traceId]` (same `TraceWaterfall` component; reached from alerts and errors) | `(app)` | auditor, admin |
| SC-06 Politici | `/policies`, `/policies/[category]` (edit, diff, history) | `(app)` | admin edit, auditor read |
| SC-07 Observabilitate | `/observability?window=5m` | `(app)` | auditor, admin |
| SC-08 Statistici | `/statistics?periodA=&periodB=` | `(app)` | auditor, admin |
| SC-09 Contoare live | `/meters` | `(app)` | admin control; auditor, dispecerat read |
| SC-10 Cameră de control | `/demo`, rendered only if `me.demoMode && me.realUser.role === 'admin'` | `(app)` | admin |
| SC-11 Jurnal de audit | `/audit?user=&action=&file=&from=&to=` | `(app)` | auditor, admin |
| Liveness probe | `/healthz` (Route Handler, returns `ok`, no proxying) | none | none |

All filter state lives in the URL (FE-03), parsed with a zod schema per screen; no URL-state library. A route the
role cannot use renders a `Forbidden` view ("Nu aveți acces la această pagină"), not a 404.

### Layouts and global chrome

| File | Contains |
|---|---|
| `app/layout.tsx` (server) | `<html lang="ro">`, font via `next/font` (self-hosted), `tokens.css`, reads the runtime config (FA-4), renders `<Providers config={…}>` |
| `app/providers.tsx` (client) | `QueryClientProvider`, `I18nProvider`, `RuntimeConfigProvider`, `MockBootstrap` (when mocks are on, waits for the MSW worker before rendering children) |
| `app/(auth)/layout.tsx` | Centred card, product name, no chrome |
| `app/(app)/layout.tsx` (server shell) | Renders `<AppShell>` (client), which contains the components below |
| `AuthGate` | Loads `me`; skeleton while loading; on 401 redirects to `/login?next=` |
| `Header` | Product name, nav filtered by capability, "Rol activ: …", `RoleSwitcher` (demo mode + real admin only), user menu, `LiveStatusPill` ("Live" / "Reconectare…"), `MockMarker` ("Date simulate"), "Actualizări live" pause switch (A11Y-14) |
| `AlertBanner` | Shown when any guarantee is not OK; links to `/` |
| `StorageHealthStrip` | Postgres · S3 · FTP; links to `/observability` |
| `UploadTray` | Fixed bottom-right; persists across navigation (lives in the `(app)` layout) |
| `SessionExpiryDialog` | Warning at T−2 min (§10) |
| `LiveBridge` | Mounts the single SSE connection (§4); renders nothing |
| `Announcer` | One polite + one assertive live region (A11Y-11) |
| `(app)/error.tsx` | Romanian error view with trace ID (§5) |

### `frontend/src` layout

```
src/
  app/                      # routes only: thin page.tsx files (metadata + one feature screen)
    layout.tsx  providers.tsx  globals.css  not-found.tsx  healthz/route.ts
    (auth)/login/page.tsx
    (app)/layout.tsx  error.tsx  page.tsx  upload/  files/  files/[fileId]/  traces/[traceId]/
          policies/  policies/[category]/  observability/  statistics/  meters/  demo/  audit/
  middleware.ts             # CSP nonce only (ADR-0012); never auth  (proxy.ts on Next 16)
  features/                 # one folder per domain: screens, components, query hooks, form schemas
    auth/ guarantees/ health/ upload/ files/ integrity/ policies/ observability/ statistics/ meters/ demo/ audit/
  components/ui/            # design-system primitives (Prompt 3; Radix-based, ADR-0019)
  components/charts/        # chart wrappers, Sparkline, RegionMap, ChartFigure, ChartTable
  lib/
    api/        client.ts  errors.ts  query-keys.ts  schema.d.ts (generated)  groups/<group>.ts
    live/       stream.ts  events.ts  bridge.ts
    upload/     engine (owned by upload-engine.md)
    integrity/  download verification (shares the hashing worker with lib/upload)
    auth/       capabilities.ts  safe-next.ts  session.ts
    i18n/       ro.ts  en.ts (P2)  index.ts (useT, plural, formatters)
    a11y/       announcer.ts
    config/     runtime-config.ts (zod-validated env)
  stores/       app-store.ts  (upload store lives in lib/upload/store.ts)
  mocks/        browser.ts  handlers/<group>.ts  seed/  scenario.ts  stream.ts  upload.ts
  styles/       tokens.css
  instrumentation.ts        # boot-time env validation (mock guard)
scripts/        check-diacritics.mjs  gen-api.mjs
tests/e2e/      smoke.spec.ts
```

**Rule:** `app/**/page.tsx` stays a server component that exports `metadata` and returns one `features/*` screen.
Components never import `lib/api/client` directly; they use the hooks in `features/*/queries.ts`.

## 2. Server vs client components

**FA-2: server components never fetch from NestJS.** Every API call goes from the browser to same-origin
`/api/v1` through TanStack Query.

| Renders on the server | Client-only (`'use client'`) |
|---|---|
| Root and group layouts (HTML shell, fonts, tokens), `metadata`/titles, the runtime config read (FA-4), static copy, `not-found` | Everything that touches data, role, session, stream, uploads, charts and forms: in practice every `features/*/*Screen.tsx` |

Why no server-side fetching:
- **Mocks live in the browser.** MSW intercepts browser requests only; server fetches would bypass mocks (D7).
- **The data is live and role-filtered**, replaced by the stream within seconds; SSR gives no demo benefit.
- **No cookie forwarding or internal URL**: otherwise the Next server needs `API_INTERNAL_URL`, forwards
  `__Host-` cookies and maps 401s, a second fetch path to secure and debug.
- **Lean pod**: the Next server does almost no work, so 256 Mi holds with margin.

**FA-3: no auth middleware.** A cookie-presence check cannot validate the session and misbehaves on mocks.
`AuthGate` on `GET /api/v1/auth/me` is the only gate. Cost: a ~100 ms skeleton before protected pages paint. A
middleware **does** exist for one job only: minting the per-request CSP nonce (ADR-0012, threat-model §6). Static
security headers go in `next.config.ts` `headers()`.

**Downloads** use a plain `<a href="/api/v1/files/{id}/content" download>`: the browser streams to disk, the cookie
is sent automatically, nothing touches Next or JS memory. Client-side re-verification (FE-04) is a separate path
in `lib/integrity`, sized per upload-engine.md §15 (≤ 64 MiB buffered; larger via `showSaveFilePicker` on
Chromium; otherwise server verification, labelled).

## 3. State

| State | Owner | Notes |
|---|---|---|
| Everything from `/api` (me, files, policies, guarantees, alerts, health, metrics, stats, meters, audit) | **TanStack Query** | Single source of server truth; the stream writes into it (§4) |
| Upload queue, per-item progress and state | **`useUploadStore` (Zustand)**, written only by the upload engine | Persisted by the engine (IndexedDB), not by the store |
| Live connection status, last event time, live-updates paused flag, session-expiry UI state | **`useAppStore` (Zustand)** | Small; non-React code (API client, stream) writes to it |
| Form drafts | react-hook-form (local) | Not global |
| Filters, pagination, selected window/period | URL search params | Shareable (FE-03) |

Zustand (≈1 KB) over React context because the upload engine and API client are non-React modules that must
write state without a component tree.

### Query keys (`lib/api/query-keys.ts`, one factory)

```ts
qk.me                          = ['auth','me']
qk.files.list(filters)         = ['files','list',filters]       qk.files.detail(id) = ['files','detail',id]
qk.files.custody(id)           = ['files','custody',id]         qk.traces.one(traceId) = ['traces',traceId]
qk.policies.all                = ['policies']                   qk.policies.history(cat) = ['policies','history',cat]
qk.guarantees                  = ['guarantees']                 qk.alerts = ['alerts']      qk.health = ['health']
qk.metrics.matrix(window)      = ['metrics','matrix',window]    qk.metrics.bulkhead = ['metrics','bulkhead']
qk.stats.s1 / s2(a,b) / s3 / periods                            qk.meters.counters / readings(filters) / simulator
qk.audit(filters)              = ['audit',filters]              qk.demo.status = ['demo','status']
```

### Freshness policy

QueryClient defaults: `staleTime: 30 s`; `refetchOnWindowFocus: false` (DevTools focus changes must not cause
refetch jumps during the demo); retry only on network errors and 5xx, at most 2 times, never on 4xx;
`placeholderData: keepPreviousData` on lists (FE-09, no page jumps).

| Keys | staleTime | Refresh |
|---|---|---|
| guarantees, alerts, health, meters.counters, simulator, demo.status | `Infinity` | Stream only (plus resync on reconnect) |
| files.list (faults) | 15 s | Stream `file.created` triggers invalidation, throttled to ≤ 1/s |
| metrics.matrix, metrics.bulkhead | 0 | `refetchInterval: 5 s` only while mounted, visible and live updates not paused |
| files.detail, custody, traces, policies, audit | 30 s | Invalidated by mutations and relevant stream events |
| stats.* | 5 min | Manual "Actualizează" button |
| me | 60 s | Also after login, role switch and the expiry warning |

When "Actualizări live" is paused (A11Y-14), the bridge buffers stream events and polling stops; resuming applies
the latest snapshot.

**Role switch:** `setQueryData(qk.me)`, then `resetQueries()` for everything else; `LiveBridge` reconnects (the
stream is filtered by the active role); uploads are untouched (BA-65).
**Logout / session end:** `clearClientState()` (ADR-0007): `queryClient.clear()`, close the stream,
`uploadEngine.pauseAll('logout')`; upload records stay (no PII, keyed by real user).

### Upload engine boundary (FA-24; internals in upload-engine.md)

- **Location:** `src/lib/upload/`; framework-free TS core; `store.ts` is the Zustand adapter.
- **Commands** (the only API the UI calls): `enqueue({ file, category, metadata })`, `pause(id)`, `resume(id)`,
  `cancel(id)`, `reattach(id, file)` (OQ-1), `pauseAll(reason)`, `resumeAll()`, `restore()` (on `(app)` mount).
- **Read model:** `useUploadStore(s => s.items)`; each item has `id, displayName, category, size, bytesConfirmed,
  speedBps, etaS, state, pausedReason?, retryInS?, clientSha256?, serverSha256?, verdict?, fileId?, traceId?,
  error?, startedAsRole, ownerUserId, availableAfterMs?`. `state` maps 1:1 to the FE-02 Romanian states.
- **Injected dependencies:** `api.uploads` (mockable) and `onCompleted(item)`, wired by `AppShell` to
  `invalidateQueries(['files'])`.
- The engine is a module singleton, so it survives `(app)` → `/login` → `(app)`.
- The tray and the Încărcare queue are read-only views plus command buttons.
- The engine never persists personal metadata (applicant name, CNP); it is sent once at create (BA-10).

## 4. Live stream

**FA-7: Server-Sent Events.** One connection per tab at `GET /api/v1/stream`, `text/event-stream`.

| Criterion | SSE | WebSocket |
|---|---|---|
| Direction needed | Server → client only | Bidirectional (unused) |
| Auth | Same-origin cookie sent automatically | Cookie on handshake + Origin check (CSWSH) |
| Traefik / Cloudflare | Plain HTTP GET, no upgrade config | Upgrade handling, own idle rules |
| Reconnect / resume | Built-in auto-reconnect + `Last-Event-ID` | Hand-written |
| NestJS | `@Sse()` built in | Gateway + adapter |
| Mocking | MSW `sse()` handler | MSW `ws` API, more code |

### Transport rules (BA-60)

- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` (stops Cloudflare
  compression/buffering), `X-Accel-Buffering: no`.
- First line `retry: 3000`.
- **Heartbeat:** a named `ping` event every **20 s** (Cloudflare drops idle origin connections after 100 s, 524).
  A named event, unlike a comment, lets the client run a **watchdog**: no event for 45 s → close and reconnect.
- Each event has a monotonically increasing `id:`.
- Filtered by the session's **active role** on the server.
- High-rate events (`meters.counters`) coalesced server-side to ≤ 2/s.
- Traefik: keep `writeTimeout` 0 (no limit); no Buffering middleware.
- Cloudflare serves HTTP/2/3 to browsers, so the 6-connection HTTP/1.1 limit does not apply in production.

### Client (`lib/live/stream.ts`)

- `new EventSource('/api/v1/stream' + (lastId ? '?lastEventId=' + lastId : ''))`.
- Native auto-reconnect handles blips and sends `Last-Event-ID`. Native retry stops (`readyState === CLOSED`)
  after a non-200; then our own backoff: 1, 2, 4, 8, 16, 30 s max, ±30 % jitter. Before each manual retry call
  `me`; a 401 starts the session-expired flow (§10).
- `online` triggers an immediate reconnect; `offline` sets the status at once.
- Status in `useAppStore.live`: `connecting | open | reconnecting(nextInS) | offline`. Header pill "Reconectare în
  N s…"; live widgets dim and show "actualizat acum X s" while not `open`.
- **FA-8 resync rule:** on every `open`, invalidate all stream-fed keys and refetch over REST. Events are
  snapshots or hints, never the only copy. `Last-Event-ID` replay is best-effort.

### Event types (payloads typed from OpenAPI `components.schemas`)

| `event:` | Payload | Cache effect (`lib/live/bridge.ts`) |
|---|---|---|
| `ping` | `{ serverTime }` | Watchdog only |
| `meters.counters` | `{ received, unique, duplicatesRejected, lost, ratePerS, at }` | `setQueryData(qk.meters.counters)` |
| `guarantees.status` | `{ items: GuaranteeStatus[] }` (snapshot) | `setQueryData(qk.guarantees)` |
| `alert.raised` / `alert.updated` | `Alert` | Upsert into `qk.alerts` |
| `storage.health` | `{ items: StorageHealth[] }` (snapshot) | `setQueryData(qk.health)` |
| `file.created` | `{ fileId, category, zone, origin, createdAt, availableAt }` | Throttled invalidate of `files.list` for that category; announce "Avarie nouă…" (FE-03) |
| `file.integrity` | `{ fileId, state, traceId }` | Invalidate `files.detail(id)` and lists |
| `upload.verified` | `{ uploadId, fileId, verdict, serverSha256, availableAfterMs }` | Hint to the upload engine to re-poll `GET /uploads/{id}` now (ADR-0003) |
| `policy.updated` | `{ category, version }` | Invalidate `policies` |
| `simulator.status` | `{ mode: 'normal'\|'peak'\|'custom', ratePerS }` | `setQueryData(qk.meters.simulator)` |
| `demo.storm` | `{ category, factor, state: 'started'\|'stopped', endsAt }` | `setQueryData(qk.demo.status)` |

Metrics (matrix, bulkhead) are deliberately **not** on the stream: they are window aggregates, so a 5 s poll is
simpler and correct.

## 5. Forms, types and the API client

- **Types:** `openapi-typescript` generates `src/lib/api/schema.d.ts` (`npm run gen:api`). Source `API_SPEC`,
  default `../docs/api/openapi.frontend-proposal.yaml`; later NestJS `GET /api/docs-json` (`/api-json` would not
  match the `/api` ingress prefix, §9). The generated file is committed, so CI does not need the backend.
- **Client (FA-10):** `openapi-fetch` (≈6 KB, typed by `paths`), `baseUrl: '/api/v1'`, `credentials:
  'same-origin'`. One middleware adds `X-Requested-With: filegrid` on non-GET (CSRF, ADR-0006) and normalises every
  non-2xx or network failure into `ApiError`. Endpoint groups (`auth, policies, uploads, files, audit, meters,
  monitoring, stats, demo`) are modules in `lib/api/groups/`, matching the mock switch granularity (§6).
- **Error shape** (BA-00a):
  ```ts
  class ApiError extends Error { status: number; code: string; fieldErrors: { field: string; code: string; message: string }[];
                                 traceId: string | null; /* body.traceId ?? header X-Trace-Id */ }
  ```
  Network failures become `code: 'NETWORK'`. `ErrorState` shows `t.errors[code] ?? t.errors.generic` and "ID
  urmărire: …" with a copy button, linking to `/traces/{id}` for roles that can view traces. The server `message`
  is shown only when no catalogue entry exists. 401 (except on login) triggers `session.expire()`. 409 on a policy
  save returns the current policy so the UI can re-show the diff (FE-06).
- **Forms (FA-11):** react-hook-form + `zodResolver`. Zod schemas are hand-written in `features/*/schemas.ts`
  with Romanian messages and UI-only rules (CNP checksum, fallback ≠ primary, chunk size within bounds), tied to
  the contract at compile time:
  `type _Check = Assert<IsAssignable<z.infer<typeof faultMetadataSchema>, components['schemas']['FaultMetadata']>>`.
  Server `fieldErrors` map back with `setError`. Responses are not runtime-validated (bundle and CPU cost; the
  generated types are the contract). The runtime env is the one exception, validated in `lib/config`.

## 6. Mock layer (FE-18)

**FA-13: MSW v2 in the browser, switchable per endpoint group at runtime.**

- Handlers in `mocks/handlers/<group>.ts` read `mocks/seed/` and a shared in-memory scenario. Seed: 4 categories,
  3 storages, 5 users/roles, guarantees, alerts, metric series, traces, stats with two labelled periods, audit
  trail, plus deterministic states for a11y runs (A11Y asks). Romanian seed text obeys the diacritics check.
- **Per-group switch:** `FILEGRID_API_MOCK` = `all` | `none` | comma list (`auth,files,monitoring`).
  `setupWorker(...enabledGroups.flatMap(h))` with `onUnhandledRequest: 'bypass'`; unmocked groups fall through
  to the real `/api`.
- **Bundle:** `mocks/*` loaded by `MockBootstrap` via dynamic `import()`, only when a group is mocked.
  `public/mockServiceWorker.js` is inert if never registered; when mocks are off the app unregisters stray workers
  (TM-16).
- **"Date simulate" marker** in the header whenever the worker is active; its popover lists mocked groups.
- **Production guard:** `instrumentation.ts` throws at boot if `NODE_ENV=production`, `FILEGRID_API_MOCK` is not
  `none`/empty, and `FILEGRID_ALLOW_MOCKS !== 'true'`. The VPS manifest sets neither; the demo-day fallback is an
  explicit two-variable `kubectl set env`, no rebuild.
- **Scenario engine (`mocks/scenario.ts`):** ticking state machine for counters (lost always 0), storms (fault
  latency climbs, guarantee "În pericol", alert raised), storage down/up, corruption. Mocked demo endpoints feed
  it. "Stop S3" gets a dev-only toggle in the marker popover.
- **Stream:** MSW `sse('/api/v1/stream', …)` emits the §4 events incl. `ping`; `?mockDrop=1` cuts it every 30 s.
- **Resumable upload:** per upload-engine.md §16 (never stores chunk bodies, server state persisted so F5 works,
  failure injection, bandwidth shaping).

## 7. Charts and map

**FA-14: Recharts for the few real charts, lazy-loaded; own SVG for sparklines and small bars.**

| Option | Size | Token rule | Effort | Verdict |
|---|---|---|---|---|
| Recharts | ~100 KB gz | SVG: `stroke="var(--chart-cat-fault)"` works directly | Low | **Chosen**, `next/dynamic` on `/observability`, `/statistics`, `/meters`, `/demo` only |
| uPlot / Chart.js | 20–70 KB | Canvas: CSS vars resolved via `getComputedStyle` | Medium | Rejected |
| visx / raw d3 | Modular | SVG | High | Rejected for 22 h |
| ECharts | >300 KB | Canvas | Low | Rejected (size) |

- Charts: bulkhead 4-line time series on a shared axis; S1 grouped bars (category × storage); S2 paired bars
  (normal vs peak); S3 hourly consumption line; matrix-cell `Sparkline` (hand-written SVG, ~30 lines).
- Series colours from `tokens.css` (`--chart-cat-meter|fault|docs|drone`, status tokens); each series also has a
  dash pattern and a direct end label; animation off under reduced motion.
- `ChartFigure` holds the title, the Romanian interpretation (FE-10) and a `<details>` "Vezi ca tabel" rendering
  `ChartTable` from the same data array, so chart and table cannot disagree (A11Y-19).
- Tooltips are React-rendered text only (SR-21).
- **FA-15 S3 map:** static hand-simplified SVG (`components/charts/RegionMap.tsx`), three `<path>`s (Muntenia,
  Banat, Dobrogea), fill `var(--map-level-1..5)`, a count label per region, table alternative; no Leaflet, d3-geo
  or tiles. Counties (if OQ-6 requires) generated once offline from Natural Earth and committed. P1.

## 8. i18n

**FA-16: minimal typed catalogue, no library.**

- `lib/i18n/ro.ts` exports a nested `as const` object; interpolations are functions
  (`retryIn: (s: number) => \`conexiune pierdută, reîncercare în ${s} s\``); plurals via `plural(n, { one, few,
  other })` over `Intl.PluralRules('ro')` (covers "20 de fișiere").
- `useT()` returns the catalogue: `t.upload.state.hashing`, fully typed.
- `en.ts` (P2) is `satisfies Catalog`, so missing English keys fail `tsc`.
- Numbers, bytes, dates via `Intl.NumberFormat('ro-RO')` and `Intl.DateTimeFormat('ro-RO', { timeZone:
  'Europe/Bucharest' })` in `lib/i18n/format.ts`. Locale fixed to `ro` at P0.
- next-intl rejected: locale routing and middleware we do not need for one language.
- **FA-17 diacritics lint:** `scripts/check-diacritics.mjs` fails on U+015E/U+015F/U+0162/U+0163 (Ş ş Ţ ţ)
  anywhere under `src/`, `mocks/`, `tests/`; runs in `npm run lint` and CI.

## 9. How `/api` reaches NestJS

**FA-18: same origin, Traefik path routing on `ppc.filegrid.cc.cd`.** `/api` → NestJS, `/` → Next. One Ingress
replaces `placeholder`, reusing the cert-manager annotation and `ppc-filegrid-tls`.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: filegrid
  namespace: filegrid
  annotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
spec:
  ingressClassName: traefik
  tls: [{ hosts: [ppc.filegrid.cc.cd], secretName: ppc-filegrid-tls }]
  rules:
    - host: ppc.filegrid.cc.cd
      http:
        paths:
          - { path: /api, pathType: Prefix, backend: { service: { name: api,      port: { number: 3000 } } } }
          - { path: /,    pathType: Prefix, backend: { service: { name: frontend, port: { number: 3000 } } } }
```

- NestJS: `app.setGlobalPrefix('api')` + URI versioning (`v1`), so resources live under `/api/v1`; no
  strip-prefix middleware. `Prefix` matches per path element, so `/api-json` would **not** reach NestJS; Swagger
  is served at `/api/docs` and `/api/docs-json`.
- Benefits: upload/download bytes never reach the Next pod; no CORS; first-party cookie; CSP `connect-src
  'self'` suffices.
- **Dev:** `next.config.ts` `rewrites()` **only when `NODE_ENV === 'development'`**: `/api/:path*` →
  `${API_DEV_PROXY_TARGET:-http://localhost:3001}/api/:path*`. The dev proxy buffers bodies with a ~30 s timeout,
  so use small files or mocks in dev; large-upload rehearsals run on the VPS. Production has no rewrites.
- **FA-19 body size and timeouts** (merged with upload-engine UE-6 in ADR-0005):

| Hop | Limit | Consequence |
|---|---|---|
| Cloudflare free | Request body ≤ **100 MB** | Chunk size **5–32 MiB**, default **8 MiB** (policy editor validates; FE-06) |
| Cloudflare | Origin must answer within **100 s** (else 524) | `complete` may answer `202` + poll; any long demo action is async |
| Cloudflare | Buffers request bodies on free plans | Browser progress means "reached the edge"; the server's confirmed parts stay the source of truth |
| Traefik v3 entrypoint | `respondingTimeouts.readTimeout` default **60 s** | Raise to 600 s in `traefik-config.yaml` (key to be checked against the bundled chart). An 8 MiB part at a throttled 100 KB/s takes ~80 s |
| Traefik | No default body limit | Do **not** add the Buffering middleware |
| NestJS | Body parsers | The part endpoint streams the raw body to storage without buffering (upload-engine.md) |

## 10. Auth transport

**FA-20: httpOnly session cookie set by NestJS** (ADR-0006).
- `__Host-fg_session`, `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`. No token is readable by JS.
- Bearer-in-memory rejected: `EventSource` cannot send `Authorization`; a plain `<a download>` of a 1 GB file
  cannot either (`fetch` + Blob would hold it in memory, breaking N3); a token in memory is lost on reload, so
  resume-after-reload needs a refresh cookie anyway; larger XSS blast radius.
- `SameSite=Strict` costs nothing: all API calls are same-site fetches from our page and the Next server never
  reads the cookie.
- CSRF: SameSite plus NestJS rejecting non-GET requests whose `Origin` is not `https://ppc.filegrid.cc.cd` or that
  lack `X-Requested-With: filegrid`. Mutations are never GET.
- **FA-21 session expiry:** `GET /api/v1/auth/me` (BA-02) returns `user, realUser, activeRole, roles,
  capabilities[], demoMode, expiresAt, serverTime`. `lib/auth/session.ts` computes `skew = serverTime −
  Date.now()` and schedules timers.
  - **T−2 min:** `SessionExpiryDialog` "Sesiunea expiră în 1:59" with **"Rămân conectat"** (`POST
    /api/v1/auth/refresh`) and "Deconectare".
  - **At expiry or any 401:** `uploadEngine.pauseAll('session')`, close the stream, `router.replace('/login?
    reason=expired&next=' + encodeURIComponent(pathname + search))`.
  - **After login:** `next` passes through `safeNext()` (relative paths starting with a single `/` only),
    `resetQueries()`, `uploadEngine.resumeAll()`; the engine resumes only items whose `ownerUserId ===
    me.realUser.id` (BA-65).
  - Uploads keep running across role switches; the tray shows `startedAsRole`.
- **FA-25 capabilities:** nav and actions gate on `me.capabilities`; until the backend provides them,
  `lib/auth/capabilities.ts` holds a copy of the FE-01 matrix, marked as fallback.

## 11. Deployment

- **Build:** `next.config.ts` sets `output: 'standalone'`, `images: { unoptimized: true }` (no `sharp`),
  `poweredByHeader: false`, static security `headers()`, dev-only `rewrites()`.
- **Dockerfile** (`frontend/Dockerfile`, multi-stage, `node:24-alpine`): `deps` (`npm ci`) → `build` (`next
  build`, `NEXT_TELEMETRY_DISABLED=1`) → `runner` (copies `.next/standalone`, `.next/static`, `public`; `USER
  node`; `NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NODE_OPTIONS=--max-old-space-size=160`; `HEALTHCHECK` on
  `/healthz`; `CMD ["node","server.js"]`). `.dockerignore` excludes `node_modules`, `.next`, tests, `.env*`.
- **Build location:** off-VPS (GitHub Actions → GHCR, or laptop + `k3s ctr images import`); `next build` peaks
  above 1 GB and must not run beside the live stack.
- **k8s** (`deploy/k8s/frontend.yaml`, proposed; owner: deploy): Deployment `frontend`, 1 replica, `requests:
  {cpu: 50m, memory: 128Mi}`, `limits: {cpu: 500m, memory: 256Mi}`; readiness/liveness on `/healthz`;
  `runAsNonRoot`, `readOnlyRootFilesystem` with an `emptyDir` at `/app/.next/cache`; Service `frontend:3000`; the
  §9 Ingress; delete `placeholder`. Expect ~70–110 Mi RSS idle; measure with `kubectl top`.
- **Environment** (no secret exists in the frontend; the Next server never calls the API):

| Variable | Kind | Example | Secret? |
|---|---|---|---|
| `NEXT_PUBLIC_APP_VERSION` | Build-time, inlined | git SHA | No |
| `FILEGRID_API_MOCK` | Runtime, read by the root layout, passed to the client (FA-4) | `none` | No |
| `FILEGRID_ALLOW_MOCKS` | Runtime, boot guard | `false` | No |
| `FILEGRID_GRAFANA_URL` | Runtime, passed to the client (optional deep link) | empty | No |
| `API_DEV_PROXY_TARGET` | Dev only | `http://localhost:3001` | No |
| `PORT`, `HOSTNAME`, `NODE_OPTIONS` | Container | see above | No |

- **FA-4 runtime config:** values that must change without a rebuild (the mock switch) are read on the server in
  `app/layout.tsx` (after `await connection()`, so rendering is dynamic) and passed to `RuntimeConfigProvider`.
  Every route renders dynamically, which the nonce CSP needs anyway. `frontend/.env.example` lists all variables.
- **F5 (one command):** the frontend contributes the image build, `deploy/k8s/frontend.yaml` and a proposed `make
  up` step after `k8s-tls-up` and the API. If the team's one command is Docker Compose: a `frontend` service with
  `mem_limit: 256m` plus a small reverse proxy with the same two routes (same-origin is required). Both are
  proposals outside `frontend/` and wait for team agreement.

## 12. Testing (sized for 22 h)

| Layer | Tool | Scope | When |
|---|---|---|---|
| Types | `tsc --noEmit` (strict) | Whole app incl. zod ↔ OpenAPI assignability checks | Pre-commit + CI |
| Lint | ESLint (`next/core-web-vitals`, `jsx-a11y` strict, `react/no-danger`) + `check-diacritics.mjs` + colour-literal ban outside `tokens.css` | Whole app | Pre-commit + CI |
| Unit | Vitest | Upload engine core (upload-engine.md §18); `safeNext`, mock production guard, stream bridge, PII mask formatters, i18n plurals, `ro`/`en` parity, token contrast pairs (A11Y-7) | CI |
| E2E smoke | Playwright, Chromium, `FILEGRID_API_MOCK=all` | Login as admin → guarantees board (4 cards) → upload a generated 3 MB fault record to "Verificat" → appears in `/files?category=fault`; `@axe-core/playwright` no serious violations on those pages; CSP has a nonce | CI + before deploy |
| Manual | Rehearsal checklist (FE-14) | Real VPS: offline/online/reload resume, memory flat, `kubectl top`, Lighthouse a11y ≥ 95, NVDA pass | Milestones 10 and 12 |

Not done deliberately: snapshot tests, visual regression, cross-browser E2E, contract tests against NestJS.

---

## Decisions

| ID | Decision | Alternatives considered | Why |
|---|---|---|---|
| FA-1 | App Router with route groups `(auth)` and `(app)`; English segments; thin server `page.tsx` rendering one client feature screen | Romanian slugs; flat `app/` | Separates chrome-less login from the shell; English file names; routing apart from logic |
| FA-2 | Server components never fetch from NestJS; all data client-side via TanStack Query on same-origin `/api/v1` | RSC fetch with cookie forwarding; hybrid | Browser mocks (D7) would be bypassed; data is live and role-filtered; one fetch path; lean pod |
| FA-3 | No auth middleware; client `AuthGate` on `me`. (A CSP-only middleware exists, ADR-0012) | Middleware cookie-presence redirect | Presence check cannot validate the session and breaks on mocks |
| FA-4 | Runtime public config read in the root layout and passed to the client; `NEXT_PUBLIC_*` only for build constants | All `NEXT_PUBLIC_*`; `output: 'export'` + nginx | Mock fallback switchable on the VPS without rebuild; keeps the boot guard |
| FA-5 | TanStack Query owns server state; one key factory; no focus refetch; `keepPreviousData` on lists | SWR; RTK Query | Cache API for the stream bridge; no refetch jumps in the demo |
| FA-6 | Zustand for the upload store and a small app store | Context; Jotai; Redux | ~1 KB; non-React modules can write state |
| FA-7 | SSE at `GET /api/v1/stream` | WebSocket; polling only | Server→client only; cookie auth and reconnect built in; plain HTTP through proxies |
| FA-8 | Events are snapshots or hints; REST resync on every (re)connect; `Last-Event-ID` best-effort | Replay as the only consistency mechanism | Correct after any gap without a server event buffer |
| FA-9 | Named `ping` every 20 s + 45 s watchdog; own 1–30 s jittered backoff after fatal errors; visible "Reconectare" | SSE comments; native retry only | Cloudflare 100 s idle cutoff; native retry stops after non-200 |
| FA-10 | `openapi-typescript` + `openapi-fetch`, endpoint-group modules | orval / openapi-generator; hand-written fetch | Smallest typed option; works from the proposal now and `/api/docs-json` later |
| FA-11 | Hand-written zod form schemas checked at compile time against generated types; no runtime response validation | Zod generated from OpenAPI; validate every response | Romanian messages and UI rules; drift still fails `tsc` |
| FA-12 | One `ApiError` (status, code, fieldErrors, traceId); trace ID in every error state; 401 → session-expired flow | Per-screen handling | N5; uniform Romanian copy keyed by code |
| FA-13 | MSW v2, per-group runtime switch `FILEGRID_API_MOCK`, production boot guard, mocks cover stream and upload | Mock server; json-server; fixtures | Components unaware; per-group switch-over; cannot ship mocks by accident |
| FA-14 | Recharts lazy-loaded on chart routes; own SVG sparklines; `var(--token)` colours; `ChartFigure` + table | uPlot; Chart.js; visx; ECharts | SVG takes CSS variables; fastest to build |
| FA-15 | Static hand-simplified SVG region map | Leaflet; d3-geo | No runtime geo dependency; P1 |
| FA-16 | Typed object catalogue + `Intl` formatters + `Intl.PluralRules('ro')` | next-intl; i18next | One locale at P0; typed keys |
| FA-17 | `check-diacritics.mjs` bans cedilla ş ţ across `src`, `mocks`, `tests` | ESLint regex only | Catches JSON, seed data and comments |
| FA-18 | Same-origin `/api` via Traefik Ingress; NestJS prefix `api` + `v1`; Swagger at `/api/docs-json`; dev-only rewrites | `api.` subdomain + CORS; Next proxy | Bytes never touch Next; no CORS; first-party cookie |
| FA-19 | Chunk 5–32 MiB (default 8); `complete` may be async (202 + poll); Traefik `readTimeout` 600 s; no Buffering | Bigger chunks; synchronous only | Cloudflare 100 MB / 100 s; Traefik 60 s read default |
| FA-20 | httpOnly `__Host-` cookie, `Secure; SameSite=Strict`; CSRF via SameSite + Origin/custom-header check | Bearer in memory + refresh cookie; localStorage | EventSource and native downloads need cookie auth; survives reload |
| FA-21 | Expiry from `me.expiresAt` + `serverTime`; warning at T−2 min with "Rămân conectat"; `safeNext` redirect; uploads paused then resumed for the same real user | Silent sliding only; modal re-login | FE-01; blocks open redirects; BA-65 |
| FA-22 | Standalone `node:24-alpine` non-root image, `--max-old-space-size=160`, 128Mi/256Mi, unoptimized images, built off-VPS | Static export + nginx; default image | ≤ 256 Mi target; keeps boot guard |
| FA-23 | `tsc`, ESLint + diacritics + colour checks, Vitest for engine and helpers, one Playwright smoke with axe | Full pyramid | Fits 22 h; covers the riskiest code and the demo path |
| FA-24 | Upload engine is a framework-free singleton in `src/lib/upload`; `useUploadStore` its only write target | Engine in hooks | Survives navigation and login; unit-testable |
| FA-25 | UI gating reads `me.capabilities`; local FE-01 matrix only as a marked fallback | Hard-coded matrix | Single source of truth (BA-03) |

## Assumptions and backend asks

| Ref | Ask / assumption | Needed by |
|---|---|---|
| BA-00d, OQ-5 | Traefik routes `/api` (Prefix) to NestJS on `ppc.filegrid.cc.cd`; NestJS `setGlobalPrefix('api')` + URI version `v1`; placeholder Ingress replaced; Service `api`, port 3000 (or tell us) | Milestone 10 |
| BA-00a | Every response carries `X-Trace-Id`; error body `{ code, message, fieldErrors[], traceId }`; `message` safe to show | Milestone 4 |
| BA-00e | OpenAPI JSON at `GET /api/docs-json` (`@nestjs/swagger`); stream payloads declared in `components.schemas` | Switch-over |
| BA-01, OQ-8 | Login sets `__Host-fg_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`); logout clears it; non-GET rejected without matching `Origin` or `X-Requested-With: filegrid` | Milestone 4 |
| BA-02 | `me` returns `user, realUser, activeRole, roles, capabilities[], demoMode, expiresAt, serverTime`; `POST /auth/refresh`; session TTL configurable | Milestone 4 |
| BA-04 | Role switch returns the new `me`; stream filtered by active role | Milestone 4 |
| BA-65 | Upload authorised at start, bound to the real user, resumable after re-login | Milestone 5 |
| BA-13 | `complete` answers 200 or `202` + poll within seconds; `upload.verified` on the stream as a hint | Milestone 5 |
| BA-11, BA-15 | Chunk 5–32 MiB; part endpoint streams the raw body | Milestone 5 |
| BA-18 | Download works as a plain GET link with cookie auth; `Content-Disposition` uses the display-safe name; stored SHA-256 in `X-File-SHA256` and in the detail | Milestone 6 |
| BA-60, OQ-9 | SSE at `/api/v1/stream` per §4 | Milestone 8 |
| BA-43, BA-44 | Metrics endpoints cheap enough to poll every 5 s on 1–2 screens | Milestone 8 |
| Infra (OQ-9) | Traefik `websecure` `readTimeout` 600 s, `writeTimeout` 0, no Buffering middleware; Cloudflare does not cache `/api/*`; no Rocket Loader | Milestone 10 |
| F5 | Team confirms the one command (k3s `make up` vs Compose); frontend supplies image, manifest and `.env.example` | Milestone 10 |
| OQ-6 | Map granularity and zone codes in the seed | Milestone 9 |
| OQ-7 | If the backend sends facts only, the frontend templates the Romanian text in `ro.ts` | Milestone 9 |
| Assumption | Images built in CI or on a laptop and imported into k3s | Milestone 10 |
