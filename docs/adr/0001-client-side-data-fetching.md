# ADR-0001: Client-side data fetching in a thin App Router shell

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; drafted by ecc:architect (FA-1, FA-2, FA-3)

## Context

The UI is live, role-filtered and must run on browser mocks before NestJS exists (PRD D7, FE-18). The Next.js pod
shares a 4 GB VPS and should do almost nothing. App Router allows fetching in server components, but that needs
cookie forwarding, an internal API URL and a second error path.

## Decision

Route groups `(auth)` and `(app)` with English segments; each `page.tsx` is a thin server component (metadata + one
client feature screen). Server components never call NestJS: all data is fetched in the browser via TanStack Query
from same-origin `/api/v1`. No auth middleware: a client `AuthGate` on `GET /auth/me` is the only gate.

## Alternatives Considered

### Alternative 1: RSC fetching with cookie forwarding
- **Pros**: faster first paint, less client JS.
- **Cons**: bypasses MSW (browser-only), needs `API_INTERNAL_URL` and cookie forwarding, two fetch paths.
- **Why not**: breaks mock-first development and adds a second path to secure.

### Alternative 2: Middleware cookie-presence redirect
- **Pros**: no skeleton flash.
- **Cons**: presence is not validity; breaks on mocks where no cookie exists.
- **Why not**: `me` is the only authoritative check.

## Consequences

### Positive
- One fetch path; mocks and real API behave the same; lean Next pod.

### Negative
- ~100 ms skeleton before protected pages paint; no SEO (irrelevant for an internal tool).

### Risks
- A middleware still exists for the CSP nonce (ADR-0012); it must never grow auth logic.
