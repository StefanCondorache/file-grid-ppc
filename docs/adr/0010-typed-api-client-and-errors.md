# ADR-0010: Generated OpenAPI types, `openapi-fetch` client, one error shape, hand-written form schemas

**Date**: 2026-11-14
**Status**: proposed (error shape needs NestJS agreement: BA-00a)
**Deciders**: frontend dev; drafted by ecc:architect (FA-10, FA-11, FA-12, FA-25); error fields merged from ecc:code-architect and ecc:security-reviewer

## Context

The REST contract is not fixed; components must never hard-code shapes (CLAUDE.md). The proposal YAML exists now;
NestJS will publish its real document later. Every error must show a trace ID (N5) and never leak internals.
Forms need Romanian messages and UI-only rules (CNP checksum).

## Decision

`openapi-typescript` generates `schema.d.ts` from `docs/api/openapi.frontend-proposal.yaml` now and from
`/api/docs-json` later; `openapi-fetch` with `baseUrl: '/api/v1'`, grouped per endpoint group. One error body:
`{ code (UPPER_SNAKE), message (Romanian, safe), fieldErrors[], traceId, retryAfterMs?, storage? }`, plus the
`X-Trace-Id` header on every response. Forms use react-hook-form + hand-written zod schemas checked at compile time
against the generated request types. UI gating reads `me.capabilities`.

## Alternatives Considered

### Alternative 1: Generated client (orval / openapi-generator)
- **Pros**: hooks for free.
- **Cons**: runtime codegen, larger bundle, harder to mock per group.
- **Why not**: `openapi-fetch` is ~6 KB and typed by `paths`.

### Alternative 2: Zod schemas generated from OpenAPI, runtime-validating every response
- **Pros**: catches backend drift at runtime.
- **Cons**: bundle and CPU cost; generic messages.
- **Why not**: drift already fails `tsc`; Romanian messages need hand-written schemas.

## Consequences

### Positive
- Contract changes break the build, not the demo; uniform Romanian errors keyed by code.

### Negative
- Hand-written form schemas duplicate request shapes (guarded by type assertions).

### Risks
- If NestJS names diverge from the proposal, regenerated types will break many call sites at once (desired, but
  plan time for it at switch-over).
