# ADR-0021: Testing sized for a 22-hour build

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; ecc:architect (FA-23), ecc:code-architect (upload test plan), ecc:a11y-architect (A11Y-26), ecc:security-reviewer (verify steps)

## Context

One developer, 22 hours. The riskiest code is the upload engine (beat 2); the riskiest outcome is a demo beat that
fails live. Success metrics include Lighthouse a11y ≥ 95 and zero cedilla characters.

## Decision

`tsc --noEmit` strict (incl. zod ↔ OpenAPI assignability); ESLint with `jsx-a11y` strict, `react/no-danger`, a
colour-literal ban and `check-diacritics.mjs`; Vitest for the upload engine (backoff, state machine, scheduler,
resume, PII allow-list, hashing) and pure helpers (incl. token contrast pairs); one Playwright smoke on mocks with
axe and a CSP-nonce check; `npm audit --audit-level=high --omit=dev`; manual rehearsal on the VPS (offline,
reload, memory, NVDA, Lighthouse).

## Alternatives Considered

### Alternative 1: Full pyramid (component, snapshot, visual, cross-browser)
- **Pros**: broader safety net.
- **Cons**: does not fit the window.
- **Why not**: time goes to the demo path.

## Consequences

### Positive
- Covers the upload engine and the demo path.

### Negative
- No contract tests against NestJS; generated types plus `tsc` stand in.

### Risks
- Mock-only E2E cannot prove memory flatness; that proof is manual on the VPS.
