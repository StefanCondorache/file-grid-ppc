# FileGrid PPC: Frontend Threat Model

*Design-time threat model (2026-11-14). No frontend code exists yet; this document sets the rules for the code to
come. Scope: the Next.js app, its browser-side behaviour, and what it asks of NestJS and Traefik. Related: N7–N10
in [context.md](../context.md); FE-01, FE-04, FE-12, FE-13, FE-15, FE-18, BA-00a..e, OQ-8 in [prd.md](../prd.md).
Author: ecc:security-reviewer agent. Cross-agent conflicts and their resolutions are recorded in the ADRs
([docs/adr/](../../adr/README.md)); where an ADR differs from this document, the ADR wins.*

## 1. Assets, actors, trust boundaries

**Assets**
- A1: Session credential.
- A2: Personal data in connection documents (name, CNP, ID scans), and their masked or clear display.
- A3: File integrity and hashes (demo-critical).
- A4: Storage topology and credentials (S3, FTP, Postgres). These must never reach the browser.
- A5: Audit trail and operation log integrity.
- A6: Demo controls (role switcher, storm, corrupt).
- A7: The production origin `ppc.filegrid.cc.cd`, and anything running JS on it.

**Actors**
- Legitimate roles: teren, dispecerat, racordari, auditor, admin.
- External attacker: a CSRF page, a malicious site opening a WebSocket, or a phishing link.
- Malicious uploader: a low-privilege user who uploads hostile file names or content.
- Insider with a lower role: tries IDOR, resume hijack or privilege escalation.
- Shared-machine user: reads what the previous user left behind in the browser.
- Compromised dependency.

**Trust boundaries**
- B1: Browser → Cloudflare → Traefik. TLS is terminated twice (Cloudflare Full strict).
- B2: Traefik path routing: `/api` → NestJS, `/` → Next.
- B3: NestJS → storages (127.0.0.1 or the cluster network). The browser never crosses this one.
- B4: The browser origin itself. Everything from the API is untrusted data until escaped.

```
 Browser (origin https://ppc.filegrid.cc.cd)
   |  HTML/JS/CSS (RSC)                    |  /api/* REST, chunk PUTs, SSE, download GET
   v                                       v
 Cloudflare proxy (SSL Full strict) --> Traefik (HTTP->HTTPS 308, LE certs)
                                          |  path routing, security-header middleware
                         "/" -------------+------------- "/api"
                          v                                  v
                  Next.js standalone                      NestJS  (auth, roles, policy,
                  (UI only, no file bytes,                 encryption, op log, audit)
                   no secrets)                               |  B3 (never exposed to browser)
                                                   S3 (SeaweedFS) | FTP | Postgres

 Browser-local state: memory (TanStack cache, Zustand) | IndexedDB (upload-queue metadata)
                      | cookie (httpOnly session, not readable by JS)
```

## 2. STRIDE table

| # | Threat | STRIDE | Impact | Primary control | Section |
|---|---|---|---|---|---|
| T1 | Token theft via XSS (localStorage or readable cookie) | I, E | Account takeover | httpOnly cookie, strict CSP | 3, 6 |
| T2 | Cross-site request forges a state change (upload start, policy edit, unmask, storm) | T, E | Unauthorised actions | SameSite + custom header + Origin check | 4 |
| T3 | CSWSH on the live stream | S, I | Live data exfiltration | SSE + Fetch-Metadata check, cookie auth | 4 |
| T4 | Stored XSS through file name, substation, reason, span name | T, E | Session abuse, PII read | React escaping, no raw HTML, CSP | 5 |
| T5 | Bidi/homoglyph/long file names spoof a name | S | Auditor misled | Display-safe name rendering | 5 |
| T6 | Uploaded SVG/HTML rendered inline | E | XSS on our origin | `attachment` + `nosniff`, never inline | 5, 9 |
| T7 | Inline-script injection (no CSP) | E | Same as T1 | Nonce CSP | 6 |
| T8 | PII leaked via cache, URL, title, logs, IndexedDB | I | Privacy breach (N9) | Server-side masking, no persistence | 7 |
| T9 | Unmask abused (wrong role or no reason) | E, R | PII exposure | Server-enforced auditor + reason + audit | 7, 11 |
| T10 | Secrets in bundle or repo | I | Full compromise | No `NEXT_PUBLIC_` secrets, `.env.example` | 8 |
| T11 | Storage URL, key or path leaks (headers, errors, presigned URLs) | I | Direct storage access (N7) | Download via `/api/.../content` only | 9 |
| T12 | IDOR on file or upload IDs | E, I | Cross-role data access | Per-object authorisation, opaque IDs | 9, 12 |
| T13 | Downgrade or mixed content | T, I | Sniffing | HSTS, Secure cookies, HTTPS only | 10 |
| T14 | Demo features abused in prod (switcher, storm, corrupt, MSW) | E, D, T | Privilege escalation, fake data | Server-side demo flag, boot guard | 11 |
| T15 | Upload hijack or resume by another user | S, E | Foreign file written | Upload bound to user | 12 |
| T16 | Client-declared size or type trusted | T, D | Policy bypass | Server enforces policy | 12 |
| T17 | Stack trace or storage detail in errors | I | Recon | Code + Romanian message + trace ID | 14 |
| T18 | Malicious dependency | T | Arbitrary code on the origin | Lockfile, audit gate | 13 |
| T19 | Shared-machine residue after logout | I | Next user sees data | Logout wipe | 3 |
| T20 | Repudiation of unmask or role switch | R | No accountability | Audit trail, backend-written | 7, 11 |

## 3. Token and session storage

| Option | XSS impact | CSRF | Reload | Verdict |
|---|---|---|---|---|
| localStorage bearer | Token stolen and exfiltrated | None | Survives | Reject |
| Bearer in memory | Usable only during XSS, not stealable later | None | Lost on reload, needs a refresh cookie anyway | Second best |
| httpOnly + Secure + SameSite cookie set by NestJS | Cannot be read; the page can still make requests | Needs controls (§4) | Survives, simple | **Recommend** |

**TM-1.**
- NestJS sets `Set-Cookie: __Host-fg_session=<opaque id>; Path=/; Secure; HttpOnly; SameSite=Strict`. No
  `Domain` attribute; `__Host-` forces Secure, Path=/ and host-only.
- The value is an opaque server-side session ID or a short-lived signed token, not a JWT carrying PII.
- SameSite: this agent first proposed Lax, because Strict drops the cookie on top-level navigation from an
  external link. **Resolved to Strict (ADR-0006):** the Next server never reads the cookie (FA-2/FA-3), so a
  top-level navigation without it costs nothing; every API call, SSE connection and download link is initiated by
  our own page and is same-site, so the cookie is always sent where it matters. Rule still holds: no state change
  on GET, including demo endpoints.
- Same-origin routing removes the need for CORS. NestJS must not enable CORS with credentials. Fetches use
  `credentials: 'same-origin'`.

**TM-2 (expiry).** Idle timeout 30 min, absolute 8 h, sliding on the server. For the demo the idle timeout may be
lengthened via env, never disabled. `GET /api/v1/auth/me` (BA-02) returns the expiry; the UI warns 2 min before
and redirects to login on 401. A 401 from any call triggers the session-end wipe.

**TM-3 (logout and client-state clearing).** One function, `clearClientState()`, called on logout, 401 and
expiry:
- `queryClient.clear()`; reset all stores; close the SSE connection.
- Pause all uploads. Upload-queue records in IndexedDB are kept, because they hold no PII (TM-10), are keyed by the
  real user, and FE-01 requires the same real user to resume after re-login. Records of a different user are
  ignored and never resumed.
- Remove Cache Storage entries if any exist.
- Logout is `POST /api/v1/auth/logout`; the server invalidates the session and sends `Set-Cookie` with `Max-Age=0`.
- Broadcast over `BroadcastChannel` so other tabs wipe too.

On **role switch** the query cache is cleared and the stream reconnects; uploads and their records are untouched
(BA-65).

**Verify.** DevTools shows the cookie HttpOnly, Secure, `__Host-`; `document.cookie` has no session; grep for
`localStorage`/`sessionStorage` (SR-3); Playwright: log out, then the query cache is empty, IndexedDB holds no
PII, and the back button shows no data.

## 4. CSRF, SSE, WebSocket, chunk uploads

**TM-4, layered controls.**
1. SameSite=Strict cookie (above).
2. **Custom header on every non-GET request**: the shared fetch wrapper adds `X-Requested-With: filegrid`. A
   cross-site form cannot set it, and setting it cross-origin triggers a CORS preflight that NestJS denies (no CORS
   configured). NestJS rejects non-GET requests without it with 403.
3. **Origin / Sec-Fetch-Site check in NestJS**: for any non-GET/HEAD request require `Origin` equal to the public
   origin, or `Sec-Fetch-Site: same-origin`; reject `cross-site` and `same-site`. If both headers are missing
   (non-browser client), allow only with a valid session plus the custom header.
4. A synchronizer or double-submit token is not needed given 1–3 on a same-origin app. Revisit only if CORS is
   ever opened.

**Chunk uploads (BA-11).** The PUTs are non-GET, so they carry the custom header and pass the Origin check.
Content-Type `application/octet-stream`, upload ID in the path. Each chunk is authorised against the user bound to
that upload (BA-65, §12), so a forged request cannot add bytes to someone else's upload.

**SSE (GET).** Same-origin `EventSource` sends cookies automatically. NestJS must authenticate the cookie on
connect, check `Sec-Fetch-Site: same-origin`, return `Cache-Control: no-cache, no-transform` and `Content-Type:
text/event-stream`, filter events per role on the server, and close the stream when the session expires (the
client reconnects, gets 401, logs out). `EventSource` cannot send custom headers, which is why the Fetch-Metadata
check matters here.

**WebSocket (not chosen).** Would need an Origin check on upgrade (CSWSH), cookie auth, no token in the query
string, `wss://` only.

**TM-5: SSE.** One-way push fits the requirements, works through Cloudflare and Traefik without upgrade handling,
reuses cookie auth, and has a smaller attack surface.

**Verify.** curl a POST without the header and a POST with `Origin: https://evil.example`: each returns 403.
Automated in NestJS e2e.

## 5. XSS and content handling

**Untrusted strings**: file names, substation, line, applicant name, trace/span names, audit reasons, policy
labels, interpretation text (BA-53), alert messages, error messages. All of it is data, never HTML.

**Rules**
- Render only through React text nodes. `dangerouslySetInnerHTML` is banned (SR-1, ESLint `react/no-danger:
  error`). No `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` (SR-2).
- Interpretation text (S1–S3) is plain text or a template filled with escaped values. No markdown-to-HTML.
- `href`s are built only from our own routes. Never put a backend string into `href`, `src` or `style`.
- **Charts**: no HTML tooltips from raw strings. React-rendered tooltips with escaped text; never `formatter`
  functions that return HTML strings. Category and span names go through `safeLabel()`.
- **File-name display (`<SafeName>`)**:
  - Normalise to NFC; strip C0/C1 control characters.
  - Strip or visibly mark bidi controls (U+202A–202E, U+2066–2069, U+200E/F) and zero-width characters
    (U+200B–D, U+FEFF).
  - Wrap in an element with `dir="auto"` and `unicode-bidi: isolate`.
  - CSS ellipsis plus full-name `title`; cap at 255 characters for rendering.
  - Homoglyphs: a "caractere neobișnuite" badge when the name mixes scripts (Latin + Cyrillic/Greek). Display
    only.
  - Connection docs already come with a server display-safe name (BA-17).
- **Downloads**: the browser must not render uploaded content on our origin. NestJS sends:
  - `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 6266
    / 5987), sanitised (no CR/LF, `/`, `\`, quotes, control or bidi characters); fallback `{id}.{ext}`.
  - `X-Content-Type-Options: nosniff`.
  - `Content-Type: application/octet-stream` unless on a safe allow-list; never `text/html` or `image/svg+xml`.
  - `Content-Security-Policy: default-src 'none'; sandbox` on the download response.
  - `Cache-Control: no-store` for connection docs.
- The frontend downloads via an anchor with `download` pointing at the content endpoint, or a streamed `fetch`
  when re-verifying the hash (FE-04, upload-engine.md §15). Never `window.open`, `<iframe>`, `<object>`, `<embed>`
  or `<img src>` for uploaded content (TM-6). Blob URLs are revoked right after use.

**Verify.** ESLint in CI; a unit test rendering `<SafeName>` with `"‮txt.exe"`, 5000 characters and
`<img onerror>`; a manual upload of `x.svg` and `x.html` confirms a download, not a render.

## 6. CSP and security headers (Next.js App Router)

**TM-7: nonce, not hash.** App Router injects inline scripts for hydration and RSC payloads, which need a
per-request nonce or `'unsafe-inline'`. Nonce-based CSP forces dynamic rendering; hash-based CSP is less mature
and changes per build. FileGrid is an authenticated live dashboard with nothing worth statically caching (and the
architecture already renders every route dynamically, FA-4), so the cost is irrelevant. Generate the nonce per
request in Next middleware (`proxy.ts` on Next 16), pass it via the `x-nonce` request header and the CSP response
header. That middleware does CSP only, never auth. No `'unsafe-eval'` in production.

**Recommended production CSP** (one line in practice):

```
default-src 'self';
script-src 'self' 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval';
style-src 'self' 'nonce-{NONCE}';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
worker-src 'self' blob:;
child-src 'self' blob:;
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
manifest-src 'self';
upgrade-insecure-requests
```

- `'wasm-unsafe-eval'` is needed for hash-wasm in the hashing worker; it does not enable JS `eval`.
- `connect-src 'self'` covers fetch and SSE on the same origin.
- `worker-src 'self' blob:`: prefer a same-origin worker file (`new Worker(new URL(...))`); keep `blob:` only if
  the bundler emits one. `'self'` also covers the MSW service worker when mocks are on.
- `style-src`: if a component library injects inline `style=""`, add `'unsafe-inline'` to `style-src` only and
  record it as a residual risk. Try the nonce first.
- Uploaded content is never an image source (§5).
- Start with `Content-Security-Policy-Report-Only` in development, enforce before the demo.
- No third-party origins: fonts self-hosted via `next/font`; no analytics, CDNs or Sentry (SR-9).

**Other headers**

| Header | Value | Set by |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload`) | Traefik headers middleware (single owner) |
| `X-Content-Type-Options` | `nosniff` | Next `headers()` and NestJS |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Next `headers()` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` | Next `headers()` |
| `Cross-Origin-Opener-Policy` | `same-origin` | Next `headers()` |
| `Cross-Origin-Resource-Policy` | `same-origin` | Next `headers()` and NestJS |
| `Cross-Origin-Embedder-Policy` | not set (no SharedArrayBuffer needed) | n/a |
| `X-Frame-Options` | `DENY` | Next `headers()` |
| `Cache-Control: no-store` | Authenticated HTML and all `/api` data | Next middleware and NestJS |
| CSP | as above | Next middleware (nonce) |

**TM-8 (one owner per header).** CSP in Next middleware (only it can mint the nonce); static headers in
`next.config` `headers()`; HSTS at Traefik only (Cloudflare HSTS off or identical); API headers in NestJS (Helmet
acceptable). `poweredByHeader: false` in Next; NestJS removes `X-Powered-By`.

**Verify.** `curl -I` on `/`, `/api/v1/ping` and a download; securityheaders.com or Mozilla Observatory on the
public host; a Playwright check fails if the response lacks a nonce or `script-src` contains `unsafe-eval` or
`unsafe-inline`.

## 7. PII masking for connection documents

**TM-9 principles.**
- **Masking is server-side.** BA-16/BA-17 return masked values (`I*** P***`, `1********123`) by default. The
  browser never receives clear PII to mask itself.
- Display-safe file names for connection docs come from the server.
- **Unmask (BA-21)**: `auditor` only, mandatory reason (server-validated minimum length), audited (who, what,
  when, reason). Other roles get 403 even when calling the endpoint directly.
- `POST .../reveal` (POST, so never cached, prefetched or logged in URLs), reason in the body. The response
  carries `expiresAt`; an audited extend is a new reveal event (accessibility A11Y-21).
- Revealed values live only in component state or a TanStack Query entry with `gcTime: 0`, `staleTime: 0`, no
  persister; never in a global store. Cleared at `expiresAt` (60 s, warning at 15 s), on navigation, on logout or
  role switch.
- Never in URLs, `document.title`, `console.*`, error reports, `localStorage`/IndexedDB, notifications (SR-10), or
  `aria-live` beyond "date afișate".
- **Search never by clear PII.** Lookup by file ID or request number.
- **CNP input**: `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"`, `inputmode="numeric"`,
  `type="text"`. Client checksum validation is a convenience only. Never logged.
- Sensitive responses: `Cache-Control: no-store`; reveal: `no-store, private`.
- Visible "Criptat în repaus" badge (N9) and a banner stating that unmask is audited.

**TM-10, IndexedDB upload-queue record.**
- Store only an allow-list (enforced centrally, upload-engine.md `pii.ts`): local queue ID, server upload ID,
  category, size, mtime, chunk size, acknowledged-part bitset, part hashes, status, real user ID, started-as role,
  created time; file name for non-PII categories only.
- **Never store CNP, applicant name or any form PII.** Connection-doc metadata is sent at upload start (BA-10) and
  held server-side; resume needs only the upload ID and the status call (BA-12). A reload before create completes
  loses the form; accepted.
- For connection documents store no file name and no file handle; the tray label is "Document racordare nr.
  {requestNumber}" until the server's display-safe name arrives; after a reload the user re-selects the file.
- Records keyed by real user ID; deleted on finish or cancel; purged after 24 h on app start; a record owned by
  another user is ignored.
- No file bytes in IndexedDB.

**Verify.** Playwright: upload a racordari doc, inspect IndexedDB (no CNP, no name); reveal then navigate away,
the query key is gone. grep: no `console.log` of form values. Unit test for the `gcTime: 0` reveal hook.

## 8. Secrets and environment

**TM-11.**
- No secret in `NEXT_PUBLIC_*` (inlined into the bundle). The Next container holds no backend secrets at all; the
  Next server never calls the API.
- The variable list is fixed by the architecture doc (§11): `NEXT_PUBLIC_APP_VERSION` (build-time) and runtime,
  non-secret `FILEGRID_API_MOCK`, `FILEGRID_ALLOW_MOCKS`, `FILEGRID_GRAFANA_URL`, read by the root layout and
  passed to the client. Nothing else may carry the `NEXT_PUBLIC_` prefix.
- Backend secrets (DB, S3, FTP, encryption key, session secret) stay in `infra/.env` (git-ignored, from
  `gen-env.sh`) and Kubernetes Secrets; never in the frontend image or build args.
- `.dockerignore` excludes `.env*` (except `.env.example`), `.git`, `node_modules`.

**TM-12.** No production browser source maps (`productionBrowserSourceMaps: false`): less recon, smaller bundle.

A secret scan (gitleaks or `git grep -nE "(AKIA|BEGIN .*PRIVATE|password\s*=)"`) runs in the quality gate.

**Verify.** After the build, grep `.next/static` for known secret values, `127.0.0.1`, internal host names and
storage ports.

## 9. Downloads, storage exposure and IDOR

**TM-13.**
- The only download path is the API content endpoint, streamed by NestJS (range supported, BA-18). **No presigned
  URLs**, no redirects to storage, no `Location` header to a storage host.
- The browser never sees bucket names, object keys, FTP paths, internal hosts, ports or credentials. Storage is a
  label (`S3`/`FTP`/`DB`, BA-00c).
- Backend checks: JSON bodies, headers (`Location`, storage-derived `ETag`, `x-amz-*`, `Server`, `Via`), errors,
  OpenAPI examples, logs shown in the UI, trace span attributes.
- Download `ETag` derives from our SHA-256, not the storage's.
- IDs are opaque (UUIDv4/ULID). Opaque IDs are not access control: NestJS authorises per object on every read
  (role + category + ownership). Return 404 rather than 403 for objects the caller may not know exist.
- Hiding a button for a role is UX only; every hidden action is refused server-side (BA-03).
- The FE-04 hash check uses the server's stored SHA-256 and hashes streamed bytes in a worker. It is integrity UX,
  not authorisation.

**Verify.** A script tries two users against each file route (expect 404/403 for foreign IDs); grep the built UI
and fixtures for `s3://`, `ftp://`, `amazonaws`, `seaweed`, `:8333`, `:21`; review headers of one real download.

## 10. HTTPS only

- Chain: Cloudflare Full (strict) → Traefik (permanent HTTP→HTTPS redirect, Let's Encrypt) → pods over
  cluster-internal HTTP. Confirm "Full (strict)" and "Always use HTTPS" in Cloudflare.
- HSTS at Traefik; cookies `Secure` + `__Host-`.
- Mixed content: `upgrade-insecure-requests`; relative URLs (`/api/...`) everywhere; no `http://` literals (SR-8).
- **TM-14**: the `next.config` `rewrites()` proxy of `/api` exists only when `NODE_ENV === 'development'`. In
  production Traefik routes; the Next server never proxies `/api` (no double hop of file bytes, no SSRF surface).
- NestJS sets `trust proxy` for exactly the Traefik hop so `Secure` cookies and Origin checks see `https`.

**Verify.** `curl -I http://ppc.filegrid.cc.cd` → 308 to HTTPS; SSL Labs / `openssl s_client`; Playwright asserts
no `http:` request in the network log.

## 11. Demo-only features as attack surface

**Role switcher (BA-04).** Tension: the PRD has the presenter (admin) switch to auditor to unmask PII (beat 4). A
switcher that lets an admin act as auditor lets a compromised admin read PII, against the separation of duties
behind N9.

**TM-15 controls.**
1. Server-side only: `admin` only, only when demo mode is on (BA-63); otherwise 403.
2. Bound to the session as an "acting role" with a TTL (15 min proposed, configurable). Every audit entry records
   `actor=<real user>, acting_as=<role>, demo=true`.
3. Switching itself is audited (who, from, to, time).
4. Server-held allow-list: admin → {teren, dispecerat, racordari, auditor}.
5. **Unmask under a switched role works only in demo mode**, needs a reason like any unmask, is audited with
   `demo=true, real_user=admin`, and is labelled in the UI ("Rol demo: auditor"). In production demo mode is off,
   `admin` cannot unmask, and a real auditor account is required.
6. Upload authorisation is bound at start (BA-65), so a role switch mid-upload cannot hijack it.
7. The client never sends a role for authorisation.

A persistent demo banner shows the acting role. The switcher renders only when `me.demoMode` is true AND the real
user is `admin`.

**Storm and corrupt (BA-61, BA-62).** 404/403 when demo mode is off; `admin` only; audited; rate-limited; POST
only. The server caps storm factor and duration so a click cannot become a DoS.

**Demo mode flag (BA-63).** Off by default, lives in backend config, the UI only mirrors it in an unmissable
banner.

**TM-16, mock API (MSW, FE-18).**
- Mocks are switched at runtime by `FILEGRID_API_MOCK` (architecture FA-13). A boot guard throws in production
  unless `FILEGRID_ALLOW_MOCKS=true` is set explicitly (the documented demo-day fallback), so mocks cannot reach the
  VPS by accident.
- Mock handlers load only via a dynamic import behind the flag. `mockServiceWorker.js` ships in `public/` (needed
  for the no-rebuild fallback) but is inert unless registered.
- A service worker on the production origin intercepts all fetches and survives deploys: when mocking is off the
  app calls `navigator.serviceWorker.getRegistrations()` on startup and unregisters every worker.
- With mocks on, a permanent "Date simulate" marker. Mock mode has fake fixtures only.

**Verify.** With `FILEGRID_API_MOCK=all` and no allow flag, the production container refuses to start; with demo
mode off, curl to each demo endpoint returns 403/404; the audit trail shows `acting_as` entries after a switch.

## 12. Upload-specific

- **TM-17: declared size and type are untrusted.** Create sends them as hints; the server enforces the category
  policy (size, types by sniffing or extension allow-list, chunk size, parallelism; BA-15), counts real bytes and
  aborts above the limit. The UI checks only for early feedback.
- **Upload bound to user and category at start (BA-65).** Every part, status, complete and cancel call checks the
  session's real user is the owner; otherwise 403/404. Upload IDs are 128-bit random.
- **Resume by another user**: queue records are per real user (§7) and the server refuses foreign upload IDs.
- **Part order and replay**: any part number within range; repeated parts idempotent; per-part SHA-256 checked;
  total parts capped; final SHA-256 verified at completion (BA-13); completion with missing parts rejected; part
  size bounded; abandoned uploads expire (BA-14).
- Rate limits per user on upload start and parts.
- No content processing, so archive bombs are irrelevant; no in-browser preview (TM-6).

## 13. Dependencies and supply chain

- Commit `package-lock.json`; `npm ci` only, in CI and the Dockerfile.
- Exact versions for direct dependencies (`save-exact=true` in `.npmrc`), especially next, react, tanstack-query,
  hash-wasm, msw and the chart library.
- Quality gate (SR-13): `npm audit --audit-level=high --omit=dev` passes, or each exception is written down.
- Few dependencies; each new runtime dependency is justified in one line. No packages that load remote scripts.
- Image: pinned base tag (digest if possible), non-root user, read-only filesystem where possible.
- Trace IDs are random, not secrets, safe to show; they never encode user, host or internal names. Span names and
  attributes (BA-20) carry operation labels only.

## 14. Error handling

- One error shape (BA-00a): `{ code, message (Romanian, human-safe), fieldErrors, traceId }`. The UI shows
  message, code and trace ID with a copy button. Never `stack`, raw server messages, SQL, storage errors or paths.
- Unknown errors fall back to "A apărut o eroare. Cod: {code}. ID urmărire: {traceId}".
- `error.tsx` and `global-error.tsx` use the same safe component; no `error.message` in production
  (`error.digest` may be shown).
- No third-party error reporter. A `logger` wrapper strips PII keys; `compiler.removeConsole` (except `error`) in
  production.
- 401 → session-end flow + redirect to login. 403 → "Nu aveți acces", with no hint whether the object exists.
  404 is used for foreign objects.
- NestJS must not log request bodies of reveal and upload start (PII).

**Verify.** Force a 500 from the mock and the real API and check the screen; grep components for `error.message`
and `.stack`.

## Security rules for the frontend code

A PR that breaks one of these is rejected.

1. **SR-1**: No `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write` (ESLint
   `react/no-danger`, `no-restricted-properties`).
2. **SR-2**: No `eval`, `new Function`, or string timers.
3. **SR-3**: No token, session or PII in `localStorage`/`sessionStorage`. IndexedDB holds only the queue metadata
   allowed by TM-10.
4. **SR-4**: Every API call goes through the single API client (`credentials: 'same-origin'`, CSRF header on
   non-GET, trace ID handling). No direct `fetch` elsewhere, except the upload part transport (XHR) and the
   download verifier, which use the same header provider.
5. **SR-5**: No state change on GET; no role or permission read from client state for authorisation (UI hiding
   is UX only).
6. **SR-6**: Demo actions (switch, storm, corrupt) are POST, visible only when `me.demoMode` is true and the real
   user is `admin`.
7. **SR-7**: Every untrusted string renders through React text nodes; file names through `<SafeName>`; no backend
   string in `href`, `src`, `style` or `srcDoc`.
8. **SR-8**: Only relative URLs (`/api/...`). No `http://` literal, storage host, bucket or key in code or
   fixtures.
9. **SR-9**: No third-party script, font, CDN, analytics or error reporter; `next/font` self-hosted only.
10. **SR-10**: PII (CNP, name, revealed values) never in URLs, `document.title`, `console`, notifications, logs,
    `aria-label` or error messages.
11. **SR-11**: The reveal hook uses `gcTime: 0`, `staleTime: 0`, no persister, and auto re-masks (timer,
    navigation, logout, role switch).
12. **SR-12**: CNP and personal-name inputs use `autocomplete="off"`, `spellcheck="false"`; values are never in
    global stores or IndexedDB.
13. **SR-13**: `package-lock.json` committed; `npm ci` only; exact versions; `npm audit --audit-level=high
    --omit=dev` passes; each new runtime dependency justified.
14. **SR-14**: Environment variables limited to the §8 list; no secret in the repo; only `.env.example` committed.
15. **SR-15**: No production source maps; `poweredByHeader: false`.
16. **SR-16**: Downloads go through the API content endpoint with the `download` attribute or the streaming
    verifier. Never `window.open`, `<iframe>`, `<object>` or `<img>` for uploaded content. Blob URLs revoked.
17. **SR-17**: MSW only behind `FILEGRID_API_MOCK` with the production boot guard; stray service workers are
    unregistered when mocks are off.
18. **SR-18**: Errors render `{code, Romanian message, traceId}` from one shared component; no `stack` or raw
    `error.message`.
19. **SR-19**: `clearClientState()` is the only session-end path (logout, 401, expiry); it never deletes another
    user's data and never cancels uploads.
20. **SR-20**: The CSP is set in middleware with a nonce; no `unsafe-eval` or `unsafe-inline` in `script-src`;
    the middleware does CSP only, never auth.
21. **SR-21**: Charts use React-rendered text-only tooltips; no HTML-string formatters.
22. **SR-22**: The hashing worker is a same-origin file; it receives bytes and returns digests only.
23. **SR-23**: Role switch, unmask and storm UI show a persistent "Rol demo / acțiune auditată" indicator.

## Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| TM-1 | Session is an opaque `__Host-` cookie set by NestJS: `HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain | Bearer in memory; localStorage bearer; SameSite=Lax | JS cannot read it, so XSS cannot steal it; same-origin routing makes it simple; Strict costs nothing because Next never reads the cookie (resolved, ADR-0006) |
| TM-2 | Idle 30 min, absolute 8 h, server-enforced, expiry in `me`, warning at T-2 min | Long-lived session; no idle timeout | Limits shared-machine and stolen-cookie exposure; N8 asks for session expiry |
| TM-3 | One `clearClientState()` wipes query cache, stores, stream and other tabs on logout, 401 and expiry; upload records survive (no PII, per real user) | Clear only the cookie; also delete upload records | Stops residue on shared machines while keeping FE-01 resume after re-login |
| TM-4 | CSRF: SameSite + `X-Requested-With: filegrid` on non-GET + Origin/Sec-Fetch-Site check in NestJS; no CORS | Double-submit token; SameSite only | Cheap, stateless, sufficient for a same-origin app |
| TM-5 | Live stream is SSE, not WebSocket | WebSocket | One-way push is enough; no CSWSH; simpler proxying |
| TM-6 | No inline preview of uploads; downloads are `attachment` + `nosniff` + `application/octet-stream` | Inline image/PDF preview | Uploaded SVG/HTML on our origin is XSS; previews are out of demo scope |
| TM-7 | Nonce-based CSP in a CSP-only Next middleware, dynamic rendering | Hash-based; `'unsafe-inline'` | Mature in App Router; dynamic rendering is already the case |
| TM-8 | HSTS only at Traefik; CSP in middleware; static headers in `next.config`; API headers in NestJS | Headers everywhere | One owner per header avoids conflicts |
| TM-9 | PII masked server-side; reveal is a POST, auditor-only, with reason; revealed values `gcTime: 0`, never persisted, auto re-mask | Mask in the browser; cache reveal | Anything sent to the browser can leak; satisfies N9 |
| TM-10 | IndexedDB queue holds an allow-list only: no CNP, no name, no file name or handle for connection docs; keyed by real user; purged after 24 h | Store the whole form; no persistence | Resume needs only upload ID and part state |
| TM-11 | Fixed, non-secret env list; frontend image has no backend secrets | Runtime env injection of secrets | Nothing secret can leak from a UI-only container |
| TM-12 | No production source maps | Publish maps | Less recon surface, smaller bundle |
| TM-13 | Downloads only via the API content endpoint; no presigned URLs; opaque IDs + per-object authz; 404 for foreign objects | Presigned S3 URLs; sequential IDs | N7; IDs alone are not authorisation |
| TM-14 | Dev `/api` rewrite only under `NODE_ENV=development`; production routing is Traefik only | Always proxy through Next | No double hop of file bytes, no SSRF surface |
| TM-15 | Role switch is server-side, session-bound, TTL, allow-listed, audited with `real_user`/`acting_as`; unmask under a switched role only in demo mode, labelled | Client-side switch; admin may always unmask | Keeps beat 4 for the demo and separation of duties in production |
| TM-16 | MSW behind a runtime switch with a production boot guard; stray service workers unregistered when mocks are off | Build-time flag that strips the worker | Keeps the no-rebuild demo fallback while preventing accidental mocks |
| TM-17 | Server enforces size/type/policy; upload bound to the real user (BA-65); idempotent parts; final hash check | Trust client metadata | Client input is untrusted; binding prevents hijack |
| TM-18 | No third-party scripts, fonts, analytics or error reporters; `connect-src 'self'` | Hosted error tracking | Tight CSP; PII and traces stay in our system |
| TM-19 | Exact-pinned dependencies, lockfile, `npm ci`, `npm audit` in the gate | Caret ranges | Reproducible builds, cheap supply-chain check |
| TM-20 | Errors show `{code, Romanian message, traceId}` from one component; production strips `console.*` | Raw messages | No leaking of internals (T17) |

## Backend asks

**NestJS**
- BA-01/BA-02: set `__Host-fg_session` per TM-1; `me` returns user, real user, active role, capabilities,
  `expiresAt`, `serverTime`, `demoMode`; server-side idle (30 min) and absolute (8 h) timeouts; logout
  invalidates the session; refresh extends it.
- New (extends BA-00): reject non-GET without `X-Requested-With: filegrid` (403); check `Origin` or
  `Sec-Fetch-Site`; no CORS; `trust proxy` for Traefik only.
- BA-60: SSE endpoint authenticated, `Sec-Fetch-Site` checked, `no-cache, no-transform`, per-role event
  filtering, closed at session end.
- BA-18: download headers: sanitised `Content-Disposition` with `filename` and `filename*`, `nosniff`,
  `application/octet-stream`, `CSP: default-src 'none'; sandbox`, `Cache-Control: no-store` for connection docs,
  ETag from our SHA-256, no storage-derived headers.
- BA-00a/BA-00c: no storage URL, key, path, host or credential in any body, header, error, trace span or OpenAPI
  example; one error shape; no stack traces; do not log bodies of reveal and upload-start requests.
- BA-16/BA-17/BA-21: server-side masking, display-safe names, no search over clear PII; reveal is a POST,
  auditor-only, mandatory reason, audited, `no-store`, returns `expiresAt`; under a demo-switched role audit
  `real_user`, `acting_as`, `demo=true`.
- BA-03: per-object authorisation on every read and write; foreign objects → 404; opaque IDs.
- BA-04/BA-63: role switch only in demo mode, admin only, allow-listed targets, TTL, audited; route disabled when
  demo mode is off.
- BA-61/BA-62: storm and corrupt → 403/404 when demo mode is off; POST, admin-only, audited, rate-limited, hard cap
  on storm factor and duration.
- BA-10..BA-15, BA-65: enforce size, type and policy server-side; upload bound to real user and category;
  idempotent parts; final SHA-256 check; expiry of abandoned uploads; rate limits on start and parts.
- `nosniff`, `no-store` and `X-Powered-By` removal on API responses.

**Traefik / deployment**
- Headers middleware: `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- Route `/api` → NestJS and `/` → Next (OQ-5) with no path rewrite exposing internals. SSE routes must not be
  buffered or compressed. Large request bodies and long timeouts on `/api` for chunked uploads.
- Keep the HTTP→HTTPS permanent redirect; confirm Cloudflare Full (strict) and "Always use HTTPS".
- Storage ports stay on 127.0.0.1 or cluster-internal (already so in `infra/docker-compose.yml`).
- Secrets only in Kubernetes Secrets and `infra/.env`; the frontend image gets none.
- Frontend image: `.dockerignore` for `.env*`, non-root user, pinned base image.

## Residual risks

Accepted for the hackathon.

1. **Cloudflare sees plaintext** (it terminates TLS). Full (strict) protects the second hop.
2. **An XSS-capable page can still call the API** with the cookie (httpOnly stops theft, not use). Mitigated by
   CSP, escaping and short sessions.
3. **`style-src` may need `'unsafe-inline'`** if a UI library injects inline styles.
4. **No CSP reporting pipeline.**
5. **Homoglyph handling is advisory** (a badge), not blocking.
6. **No malware scanning** of uploads; files are stored and served only as attachments.
7. **Demo mode in the live demo** lets an admin act as auditor; controlled by audit and TTL. Production must run
   with demo mode off.
8. **IndexedDB metadata** (file name for non-PII categories, size, upload ID) stays until finish or 24 h; could be
   sensitive on a shared machine.
9. **Dependency risk** only partly addressed (audit, pinning); no SBOM or signature checks.
10. **No formal pen test or DAST** in the window; verification relies on the manual and Playwright checks above.
11. **Client clock expiry is advisory**; the server is the authority.
12. **Shared parent domain** (`cc.cd`): `__Host-` stops sibling subdomains overwriting the cookie, but XSS on a
    sibling host is out of our control.
13. **`mockServiceWorker.js` ships in the production image** (inert unless registered) to keep the no-rebuild demo
    fallback.
