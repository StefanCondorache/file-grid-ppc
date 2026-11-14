# ADR-0020: Standalone Node container with runtime config and no secrets

**Date**: 2026-11-14
**Status**: proposed (k8s manifest and one-command start need team agreement: F5) — revisit: backend differs, see [backend sync](../api/backend-sync-2026-11-14.md)
**Deciders**: frontend dev; ecc:architect (FA-4, FA-22) and ecc:security-reviewer (TM-11, TM-12); resolves differing env-variable lists

## Context

The VPS has 4 GB RAM shared by k3s, storage, backend and frontend (target ≤ 256 Mi for the frontend). The mock
fallback must be switchable without a rebuild. `NEXT_PUBLIC_*` is inlined at build time. The two agents proposed
different variable names (`NEXT_PUBLIC_MOCK_API`, `NEXT_PUBLIC_DEMO_UI` vs `FILEGRID_API_MOCK`, …).

## Decision

`output: 'standalone'`, `node:24-alpine`, non-root, `--max-old-space-size=160`, requests 128Mi / limits 256Mi,
images unoptimized, built off-VPS. Variables: `NEXT_PUBLIC_APP_VERSION` (build-time) and runtime, non-secret
`FILEGRID_API_MOCK`, `FILEGRID_ALLOW_MOCKS`, `FILEGRID_GRAFANA_URL`, read by the root layout and passed to the
client; `API_DEV_PROXY_TARGET` in dev only. Demo-UI visibility comes from `me.demoMode`, not an env var. No
production source maps. The frontend holds no secret.

## Alternatives Considered

### Alternative 1: Everything as `NEXT_PUBLIC_*` (security-reviewer's list)
- **Pros**: simple.
- **Cons**: changing the mock switch needs a rebuild.
- **Why not**: blocks the demo-day fallback.

### Alternative 2: Static export served by nginx
- **Pros**: tiny image.
- **Cons**: no boot guard, no CSP nonce.
- **Why not**: both are required (ADR-0011, ADR-0012).

## Consequences

### Positive
- Fits the memory budget; nothing secret can leak from the image.

### Negative
- Every route renders dynamically (negligible at our traffic).

### Risks
- `next build` must never run on the live VPS (> 1 GB peak).
