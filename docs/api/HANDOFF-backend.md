# Frontend → backend handoff (FileGrid PPC)

*From the frontend, 2026-11-14. Contract: [openapi.frontend-proposal.yaml](openapi.frontend-proposal.yaml) (39 paths).
Why each choice was made: [docs/adr/](../adr/README.md). Everything here is a **proposal**: change anything that
hurts you, but tell me before you implement it differently so I can update the mocks.*

**How we work:** I build every screen against browser mocks of this contract and switch to your API one endpoint
group at a time (`auth, policies, uploads, files, audit, meters, monitoring, statistics, demo, stream`). Nothing on
my side waits for you. The sooner `GET /api/docs-json` (`@nestjs/swagger`) is live, even partial, the sooner I can
generate types from your real DTOs and catch drift.

## Decisions that affect you

| Topic | What I need from NestJS | ADR |
|---|---|---|
| **Routing** | Same host. Traefik sends `/api` → NestJS, `/` → Next. `app.setGlobalPrefix('api')` + URI versioning `v1` → all routes under `/api/v1`. Swagger at `/api/docs` + `/api/docs-json` (not `/api-json`: it would not match the `/api` route). Service name `api`, port 3000? | 0002 |
| **Auth** | Login sets `__Host-fg_session` = opaque session id, `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`. `GET /auth/me` returns user, real user, active role, capabilities, `demoMode`, `expiresAt`, `idleExpiresAt`, `serverTime`. `POST /auth/refresh`. Idle 30 min, absolute 8 h (configurable). `trust proxy` for Traefik. | 0006, 0007 |
| **CSRF** | Global guard: non-GET without `X-Requested-With: filegrid`, or with a foreign `Origin` / `Sec-Fetch-Site`, → 403 `CSRF_REJECTED`. No CORS at all. No state change on GET. | 0006 |
| **Errors + tracing** | Every response (incl. errors, 202, SSE) carries `X-Trace-Id`. One error body: `{ code: UPPER_SNAKE, message: Romanian & safe, traceId, fieldErrors[] }` (+ `retryAfterMs`, `storage`, `missingRanges`, hashes where relevant). No stack traces, no storage details. | 0010 |
| **Upload protocol** | Custom chunk API, not tus: `POST /uploads` (requires `Idempotency-Key`), `PUT /uploads/{id}/parts/{n}` (raw octet-stream, `X-Part-SHA256`, idempotent), `GET /uploads/{id}` (received ranges), `POST /uploads/{id}/complete` (client SHA-256 → 200 verdict, or 202 + `Retry-After` and I poll), `DELETE`, `HEAD /ping`. Parts 5–32 MiB from the policy. **The part route must stream to storage with no body parser** (server memory must stay flat for 1 GB). Hash each part while streaming; whole-file SHA-256 by in-order read-back at `complete`. Auth checked once at create, bound to the **real user** (role switch / re-login must not break it). | 0003, 0005 |
| **Live stream** | SSE at `GET /api/v1/stream` (Nest `@Sse()`), not WebSocket. Headers `no-cache, no-transform`, `X-Accel-Buffering: no`; `retry: 3000`; named `ping` every 20 s (Cloudflare kills idle >100 s); monotonic `id:`; filtered by active role; counters coalesced ≤ 2/s. Event names and payloads: `x-sse-events` in the YAML (register payload classes with `@ApiExtraModels`). | 0008 |
| **Downloads** | Only `GET /files/{id}/content`, streamed, `Range` support, `Content-Disposition: attachment` (sanitised `filename*`), `nosniff`, `X-File-SHA256`, ETag from our hash. **Never** presigned URLs, redirects, bucket keys or FTP paths anywhere. `409 FILE_CORRUPT` with both hashes when you detect it before streaming. | 0014 |
| **Personal data** | Connection-doc name/CNP masked by you in every response; `displayName` never contains PII; reveal = `POST /files/{id}/reveal` with reason, auditor only, audited, returns `expiresAt` (60 s). Don't log reveal or upload-start bodies. | 0013 |
| **Roles + demo** | Enforce the FE-01 matrix on every endpoint; invisible objects → 404. Demo endpoints (`/demo/*`, simulator PUT) → 404 when demo mode is off (default off). Role switch = server-side acting role, admin + demo only, TTL, every action audited with `real_user` + `acting_as`. Storm factor/duration capped server-side. | 0015 |
| **Lists** | `{ data, meta: { page, pageSize, total, hasMore } }`, `page`/`pageSize` query params, newest first by default. Every item carries an `origin` tag (`manual/simulator/storm/seed`) and lists accept `excludeGenerated`. | — |

## Please confirm (blocking order)

1. [ ] **Routing + prefix** `/api/v1`, Service name/port, and who edits the Ingress + `traefik-config.yaml` (`readTimeout` 600 s, no Buffering middleware). *(OQ-5)*
2. [ ] **Cookie + CSRF guard** as above, and the `me` shape. *(OQ-8)*
3. [ ] **Upload protocol** (custom chunk API, 202 + poll on slow `complete`), and disk space for staging FTP/Postgres parts on the VPS. *(OQ-2)*
4. [ ] **Error shape + `X-Trace-Id`** on every response, and that traces come from the operation log (D5).
5. [ ] **SSE** at `/api/v1/stream` with the event list. *(OQ-9)*
6. [ ] **Storage outage behaviour**: write to fallback, or fail with `503 STORAGE_UNAVAILABLE`? *(OQ-4)*
7. [ ] **Corrupt-a-file**: which storages can you corrupt in place (S3 object, FTP file, DB row)? *(OQ-11)*
8. [ ] **Who builds the meter simulator**, and does it take rate control via `PUT /meters/simulator`? *(OQ-3)*
9. [ ] **Guarantee thresholds** ("În pericol" / "Încălcat"): your config, which values? *(OQ-12)*
10. [ ] **Interpretation text** for statistics: you send Romanian `text`, or only `facts` and I template? *(OQ-7)*
11. [ ] **Map granularity**: 3 regions or counties, and the zone codes in the seed. *(OQ-6)*
12. [ ] **Seed history**: at least one labelled normal day and one peak day before the demo. *(BA-70)*

Reply inline in this file or in the team chat; I update the YAML and mocks the same hour.
