# ADR-0002: Same-origin `/api/v1` through Traefik path routing

**Date**: 2026-11-14
**Status**: proposed (needs backend + deploy agreement: OQ-5) — revisit: backend differs, see [backend sync](../api/backend-sync-2026-11-14.md)
**Deciders**: frontend dev; drafted by ecc:architect (FA-18) and ecc:security-reviewer (TM-14); NestJS team to confirm

## Context

1 GB+ uploads must never pass through the Next.js server (N3, CLAUDE.md). The host `ppc.filegrid.cc.cd` already
runs Traefik with cert-manager and an HTTP→HTTPS redirect. Cross-origin calls would need CORS with credentials.

## Decision

One Ingress on `ppc.filegrid.cc.cd`: `/api` (Prefix) → NestJS Service, `/` → Next. NestJS uses
`setGlobalPrefix('api')` + URI versioning, so resources live under `/api/v1`; Swagger at `/api/docs` and
`/api/docs-json`. A `next.config` rewrite of `/api` exists only when `NODE_ENV === 'development'`.

## Alternatives Considered

### Alternative 1: `api.` subdomain with CORS
- **Pros**: independent routing.
- **Cons**: CORS with credentials, cookie scoping, wider CSP.
- **Why not**: more attack surface, no benefit.

### Alternative 2: Proxy `/api` through Next (rewrite or Route Handler)
- **Pros**: one service to expose.
- **Cons**: every upload byte passes through the Next pod; SSRF surface.
- **Why not**: violates N3 and the CLAUDE.md rule.

## Consequences

### Positive
- No CORS; first-party `__Host-` cookie; CSP `connect-src 'self'`.

### Negative
- `/api-json` (the NestJS default Swagger path) does not match the `/api` prefix, so type generation uses
  `/api/docs-json`. The Prompt 2 text said `/api-json`; this ADR changes it.

### Risks
- The dev proxy buffers bodies (~30 s timeout): large-upload rehearsals must run on the VPS.
