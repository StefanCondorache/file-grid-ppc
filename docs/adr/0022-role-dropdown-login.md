# ADR-0022: Log in by choosing a role from a dropdown

**Date**: 2026-11-14
**Status**: accepted (frontend); backend implementation pending (backend approach undecided)
**Deciders**: frontend dev (user decision); amends ADR-0015 and PRD D4 / FE-01 / SC-01

## Context

The demo switches persona several times in a few minutes (teren, dispecerat, racordari, auditor, admin). Typing
usernames is slow and error-prone on stage. The brief still requires authenticated access (N8), and beat 2's upload
must keep running while the persona changes.

## Decision

The login screen shows a **"Rol" dropdown** with the five roles (Echipă de teren, Dispecerat, Angajat racordări,
Auditor, Administrator), each backed by one demo account, plus a **password** field. In demo mode the header's
"Rol activ" pill opens the same dropdown and switches persona without logging out (audited, as in ADR-0015), so
uploads continue. With demo mode off, changing role means logging out and choosing another role.

## Alternatives Considered

### Alternative 1: Username + password per persona
- **Pros**: conventional.
- **Cons**: slow on stage; typos.
- **Why not**: presentation ease.

### Alternative 2: Role dropdown without a password
- **Pros**: one click.
- **Cons**: no authentication, fails N8; anyone at the venue could open personal data.
- **Why not**: the brief requires authenticated access.

### Alternative 3: Change role only by logging out
- **Pros**: no acting-role logic on the server.
- **Cons**: logout pauses beat 2's upload; only the teren account could resume it.
- **Why not**: breaks the resilience beat.

## Consequences

### Positive
- Fast, legible persona changes; the role is always visible.

### Negative
- Demo accounts per role must be seeded by the backend (BA-01, BA-02, BA-04).

### Risks
- The backend currently has two roles (`admin`, `operator`) and no settled auth approach; until it decides, the
  login runs on mocks.
