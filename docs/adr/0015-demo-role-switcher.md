# ADR-0015: Server-side, audited, time-boxed demo role switcher

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: BA-04, BA-63; switcher shape open, see Risks)
**Deciders**: frontend dev; ecc:security-reviewer (TM-15), ecc:architect (FA-21, FA-25), ecc:a11y-architect (A11Y-22)

## Context

D4: five real roles, and the presenter logs in once as `admin` and switches persona. Beat 4 needs `admin` to act as
`auditor` to unmask PII, which conflicts with separation of duties (N9). FE-01 asks for a one-click switch; the
a11y plan proposes a menu (two clicks).

## Decision

The switch is a server-side "acting role" on the session: admin only, demo mode only, allow-listed targets
(teren, dispecerat, racordari, auditor), TTL (15 min proposed, configurable), every switch and every action audited
with `real_user`, `acting_as`, `demo=true`. Unmask under an acting role works only in demo mode and is labelled
"Rol demo: auditor". The client never sends a role for authorisation. UI: Radix DropdownMenu radio group in the
header (A11Y-22) unless the presenter needs one click (then a segmented radio group).

## Alternatives Considered

### Alternative 1: Client-side role switch
- **Pros**: trivial.
- **Cons**: authorisation from the client; no audit.
- **Why not**: violates BA-03.

### Alternative 2: Separate logins per persona
- **Pros**: no special mechanism.
- **Cons**: stalls a 7-minute demo.
- **Why not**: D4 chose the switcher.

## Consequences

### Positive
- Beat 4 works; production (demo mode off) keeps admin unable to unmask.

### Negative
- Backend complexity: acting role on the session, audit fields.

### Risks
- The TTL must exceed the demo length; one-click vs menu is still the presenter's call.
