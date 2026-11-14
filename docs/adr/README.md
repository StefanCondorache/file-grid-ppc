# Architecture Decision Records

Decisions from Prompt 2 (2026-11-14). All are **proposed** until the frontend dev and, where marked, the NestJS
team accept them. Sources: [frontend-architecture.md](../frontend/architecture/frontend-architecture.md),
[upload-engine.md](../frontend/architecture/upload-engine.md),
[threat-model.md](../frontend/architecture/threat-model.md),
[accessibility.md](../frontend/architecture/accessibility.md). Where an ADR differs from those documents, the ADR
wins. Contract: [openapi.frontend-proposal.yaml](../api/openapi.frontend-proposal.yaml).

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-client-side-data-fetching.md) | Client-side data fetching in a thin App Router shell | proposed | 2026-11-14 |
| [0002](0002-same-origin-api-routing.md) | Same-origin `/api/v1` through Traefik path routing | proposed (backend) | 2026-11-14 |
| [0003](0003-custom-chunk-upload-protocol.md) | Custom chunk upload API instead of tus | proposed (backend) | 2026-11-14 |
| [0004](0004-client-hashing-and-resume.md) | Hash-first SHA-256 in a Web Worker; resume from IndexedDB and file handles | proposed | 2026-11-14 |
| [0005](0005-chunk-size-and-proxy-timeouts.md) | Chunk size 5–32 MiB, adaptive parallelism, raised Traefik read timeout | proposed (deploy) | 2026-11-14 |
| [0006](0006-session-cookie-and-csrf.md) | httpOnly `__Host-` session cookie (SameSite=Strict) and header-based CSRF | proposed (backend) | 2026-11-14 |
| [0007](0007-session-expiry-and-client-state.md) | Session expiry, `clearClientState()`, upload records survive logout | proposed | 2026-11-14 |
| [0008](0008-sse-live-stream.md) | SSE for live updates, snapshot resync, heartbeat | proposed (backend) | 2026-11-14 |
| [0009](0009-client-state-management.md) | TanStack Query + Zustand | proposed | 2026-11-14 |
| [0010](0010-typed-api-client-and-errors.md) | Generated types, `openapi-fetch`, one error shape, hand-written forms | proposed (backend) | 2026-11-14 |
| [0011](0011-mock-api-msw.md) | MSW mock API, per-group runtime switch, production boot guard | proposed | 2026-11-14 |
| [0012](0012-csp-nonce-and-security-headers.md) | Nonce CSP in a CSP-only middleware; one owner per header | proposed | 2026-11-14 |
| [0013](0013-pii-handling.md) | Server-side PII masking, audited time-boxed reveal | proposed (backend) | 2026-11-14 |
| [0014](0014-downloads-and-integrity.md) | Downloads only via the API; sized client re-verification | proposed (backend) | 2026-11-14 |
| [0015](0015-demo-role-switcher.md) | Server-side, audited, time-boxed demo role switcher | proposed (backend) | 2026-11-14 |
| [0016](0016-charts-and-map.md) | Recharts (lazy) + own SVG, every chart with a table | proposed | 2026-11-14 |
| [0017](0017-i18n-and-diacritics.md) | Typed message catalogue + cedilla lint | proposed | 2026-11-14 |
| [0018](0018-accessible-colour-tokens.md) | Functional colour tokens separate from the brand palette | proposed (design) | 2026-11-14 |
| [0019](0019-a11y-primitives-and-announcer.md) | Radix primitives, one announcer, live-updates pause | proposed | 2026-11-14 |
| [0020](0020-deployment-and-runtime-config.md) | Standalone container, runtime config, no secrets | proposed (deploy) | 2026-11-14 |
| [0021](0021-testing-strategy.md) | Testing sized for a 22-hour build | proposed | 2026-11-14 |

Template for new records: [template.md](template.md).
