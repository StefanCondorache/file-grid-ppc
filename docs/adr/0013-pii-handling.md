# ADR-0013: Server-side PII masking, audited time-boxed reveal, no PII in browser storage

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: BA-16, BA-17, BA-21)
**Deciders**: frontend dev; merged from ecc:security-reviewer (TM-9, TM-10), ecc:code-architect (UE-11, UE-12) and ecc:a11y-architect (A11Y-21)

## Context

Connection documents carry name and CNP (N9). Anything sent to the browser can leak via devtools, caches or
extensions. Beat 4 shows masked data, a failed unmask for `racordari` and an audited unmask by `auditor`. WCAG
2.2.1 requires a warning and an extension before a timed re-mask.

## Decision

The backend returns masked values and display-safe names by default; the browser never masks clear data itself.
Reveal is `POST …/reveal` with a reason, auditor-only, audited, `no-store`, returning `expiresAt` (60 s); the UI
warns at 15 s and offers an audited "Prelungește". Revealed values live only in component state or a `gcTime: 0`
query, cleared on timeout, navigation, logout and role switch. IndexedDB upload records hold an allow-list only:
no CNP, no name, and for connection documents no file name and no file handle. PII never appears in URLs, titles,
logs, notifications or accessible names (masked values read as "mascat").

## Alternatives Considered

### Alternative 1: Mask in the browser
- **Pros**: one API shape.
- **Cons**: clear PII reaches the client.
- **Why not**: fails N9 in spirit and in an audit.

### Alternative 2: Untimed reveal
- **Pros**: simpler.
- **Cons**: data stays on screen indefinitely.
- **Why not**: the threat model requires auto re-mask; a11y requires the warning.

## Consequences

### Positive
- Personal data is visible only after an audited, time-boxed action.

### Negative
- Connection documents always need a re-select after reload (small files, little impact).

### Risks
- Backend forgetting a field in the masked view: the a11y and security checks include a grep of rendered DOM.
