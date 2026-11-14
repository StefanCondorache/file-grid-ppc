# ADR-0006: httpOnly `__Host-` session cookie (SameSite=Strict) and header-based CSRF defence

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: OQ-8) — revisit: backend differs, see [backend sync](../api/backend-sync-2026-11-14.md)
**Deciders**: frontend dev; resolves a conflict between ecc:architect (FA-20, Strict, `X-Requested-With: filegrid`) and ecc:security-reviewer (TM-1/TM-4, Lax, `X-Requested-With: fetch` or `X-FG-CSRF`)

## Context

`EventSource` cannot send an `Authorization` header, and a native `<a download>` of a 1 GB file cannot either;
resume after reload needs credentials that survive a reload. Any token readable by JS is stealable by XSS. Both
agents chose an httpOnly cookie but disagreed on SameSite and on the CSRF header name.

## Decision

NestJS sets `__Host-fg_session=<opaque id>; Path=/; Secure; HttpOnly; SameSite=Strict` (no `Domain`). CSRF
defence: SameSite=Strict + every non-GET request carries `X-Requested-With: filegrid` + NestJS checks `Origin`
(or `Sec-Fetch-Site: same-origin`) on non-GET. No CORS. No state change on GET.

## Alternatives Considered

### Alternative 1: SameSite=Lax (security-reviewer)
- **Pros**: an external link to the app arrives with the cookie.
- **Cons**: allows the cookie on cross-site top-level GETs.
- **Why not**: the Next server never reads the cookie (ADR-0001), so a cookie-less top-level navigation costs
  nothing; all API calls originate from our page and are same-site.

### Alternative 2: Bearer token in memory + refresh cookie
- **Pros**: no ambient credential.
- **Cons**: breaks `EventSource` and native downloads; lost on reload.
- **Why not**: incompatible with N3 and beat 2.

### Alternative 3: Double-submit CSRF token
- **Pros**: classic.
- **Cons**: state and work with no extra protection on a same-origin app without CORS.
- **Why not**: header + Origin check suffices.

## Consequences

### Positive
- No token reachable by JS; SSE and downloads authenticate automatically.

### Negative
- NestJS must implement the header + Origin guard globally.

### Risks
- If CORS is ever opened, this ADR must be revisited.
