# ADR-0007: Session expiry, `clearClientState()`, and upload records surviving logout

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; resolves a conflict between ecc:security-reviewer (TM-3: delete upload records on logout and role switch) and the PRD/ecc:architect (FE-01, FA-21: uploads survive role switch; same real user resumes after re-login)

## Context

N8 asks for session expiry; FE-01 asks for a visible warning, return to the same page, and upload resume after
re-login. The threat model wanted logout and role switch to wipe IndexedDB upload records; the PRD says role switch
must never break an upload and that queue metadata survives logout. Accessibility (2.2.1) requires a way to extend.

## Decision

Server-side idle timeout 30 min, absolute 8 h (configurable for rehearsal). `me` returns `expiresAt` and
`serverTime`; the UI warns at T−2 min with "Rămân conectat" (`POST /auth/refresh`). One `clearClientState()` runs
on logout, 401 and expiry: clears the query cache and stores, closes the stream, pauses uploads, broadcasts to
other tabs. Upload records are **kept** (they hold no PII, ADR-0013) and resume only for the same real user. Role
switch clears the query cache and reconnects the stream; uploads are untouched.

## Alternatives Considered

### Alternative 1: Delete upload records on logout and role switch (security-reviewer)
- **Pros**: nothing left on a shared machine.
- **Cons**: contradicts FE-01 and BA-65; a role switch in beat 2 would kill the demo upload.
- **Why not**: the records contain no PII; other users' records are ignored and purged after 24 h.

## Consequences

### Positive
- Beat 2 survives role switches and session expiry; shared-machine residue limited to non-PII metadata.

### Negative
- File names of non-PII categories may remain in IndexedDB up to 24 h (residual risk).

### Risks
- Clock skew affects only the warning; the server is the authority.
