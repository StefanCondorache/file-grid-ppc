# ADR-0012: Nonce-based CSP in a CSP-only middleware; one owner per security header

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; resolves a conflict between ecc:security-reviewer (TM-7/TM-8: CSP with nonce in middleware) and ecc:architect (FA-3: no middleware; headers in `next.config`)

## Context

App Router injects inline scripts, so a strict CSP needs a per-request nonce, which only middleware can mint and
which forces dynamic rendering. The architecture already renders every route dynamically (FA-4) and rejected
middleware only for auth. hash-wasm needs `'wasm-unsafe-eval'`; the hashing worker and MSW need `worker-src`.

## Decision

A middleware (`proxy.ts` on Next 16) whose only job is to mint the nonce and set the CSP:
`default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'; style-src 'self'
'nonce-…'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; child-src
'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self';
upgrade-insecure-requests`. Static headers (nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP,
X-Frame-Options) in `next.config` `headers()`; HSTS only at Traefik; API and download headers in NestJS.

## Alternatives Considered

### Alternative 1: Static CSP in `next.config` with `'unsafe-inline'`
- **Pros**: no middleware.
- **Cons**: voids most XSS protection.
- **Why not**: file names and metadata are attacker-controlled strings.

### Alternative 2: Hash-based CSP
- **Pros**: static pages possible.
- **Cons**: less mature in App Router; hashes change per build.
- **Why not**: no static pages to preserve.

## Consequences

### Positive
- Strong XSS defence; headers have exactly one owner.

### Negative
- A middleware exists; reviewers must keep it CSP-only.

### Risks
- A UI library injecting inline styles may force `'unsafe-inline'` in `style-src` only (accepted residual risk).
