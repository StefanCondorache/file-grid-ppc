# ADR-0011: MSW mock API with a per-group runtime switch and a production boot guard

**Date**: 2026-11-14
**Status**: accepted, amended 2026-11-14 (user decision: build-time `NEXT_PUBLIC_API_MOCKS`)
**Deciders**: frontend dev; resolves a conflict between ecc:architect (FA-13: runtime `FILEGRID_API_MOCK`, worker shipped) and ecc:security-reviewer (TM-16: build-time `NEXT_PUBLIC_MOCK_API`, worker removed from the production image)

## Context

D7/FE-18: every screen is built on mocks and switched to NestJS one endpoint group at a time; on demo day a late
endpoint must be able to fall back to mocks. A service worker on the production origin intercepts all fetches and
survives deploys, so mocks must never ship by accident.

## Decision

MSW v2 in the browser. `FILEGRID_API_MOCK` (`all` | `none` | comma list of groups) is read at runtime by the root
layout; unmocked groups pass through. `instrumentation.ts` throws at boot in production when mocks are requested
without `FILEGRID_ALLOW_MOCKS=true`. Handlers load by dynamic import; `mockServiceWorker.js` ships in `public/` but
is inert unless registered; when mocks are off the app unregisters any stray service worker. A "Date simulate"
marker is always visible while any group is mocked. Mocks cover the SSE stream and the upload protocol.

## Alternatives Considered

### Alternative 1: Build-time flag and worker stripped from the image (security-reviewer)
- **Pros**: nothing mock-related in the production image.
- **Cons**: the demo-day fallback needs a rebuild and redeploy on a loaded 4 GB VPS.
- **Why not**: the boot guard plus unregistering keeps the risk low while preserving a two-variable fallback.

### Alternative 2: A separate mock server (json-server / NestJS stub)
- **Pros**: realistic network.
- **Cons**: another process; no per-group pass-through in the browser.
- **Why not**: more moving parts for one developer.

## Consequences

### Positive
- Components never know about mocks; per-group switch-over; rehearsable beats on mocks alone.

### Negative
- Memory-flat upload proof only works against the real backend (MSW reads parts into the page).

### Risks
- Forgetting to unset the fallback after the demo: the marker and the explicit allow flag make it visible.

## Amendment (2026-11-14)

The user chose one build-time switch, `NEXT_PUBLIC_API_MOCKS=0|1`, instead of the runtime `FILEGRID_API_MOCK`.
`NEXT_PUBLIC_API_MOCK_GROUPS` (optional) selects **hybrid** mode: mocked groups are answered in-page through the API
client's `fetch` (MSW `getResponse`), no service worker, and `uploads`/`files` are never mocked in hybrid mode so real
upload parts and downloads are not copied through a worker. The production guard now runs inside `next.config.ts`
(`PHASE_PRODUCTION_BUILD`, after `loadEnvConfig`), so `.env.local` cannot sneak mocks into a release; the demo-day
fallback is a separately built `:fullmock` image (`FILEGRID_ALLOW_MOCKS=1`), swapped with one `kubectl set image`
(Task 5.14). Cost: switching back to mocks on demo day needs that prebuilt image instead of an env change.
