# ADR-0019: Radix UI primitives, one live-region announcer, and a global live-updates pause

**Date**: 2026-11-14
**Status**: proposed (adds a control not in the PRD)
**Deciders**: frontend dev; drafted by ecc:a11y-architect (A11Y-1, A11Y-11..A11Y-17, A11Y-23)

## Context

One developer has 22 hours; dialogs, menus and tabs must be accessible without hand-rolling focus management. The
demo is full of moving data (counters, fault list, storm alerts, upload progress, retry countdowns) that would
flood a screen reader. WCAG 2.2.2 (Level A) requires pausing auto-updating content. 1.4.10 (AA) requires 320 px
reflow even though phone layouts are P2.

## Decision

Radix UI primitives plus native `<select>`, `<table>`, `<details>`. One `Announcer` with a polite and an assertive
region, deduped and rate-limited; upload progress announced at 25 % steps only, retry countdowns `aria-hidden`;
counters never live, with an on-demand summary; the alert banner has no live role (the announcer speaks it). A
global "Actualizări live" switch pauses counters, the fault list and the health strip. A minimal responsive shell
reflows to 320 px. The drop zone always contains a real "Alege fișiere" button.

## Alternatives Considered

### Alternative 1: React Aria
- **Pros**: stronger guarantees.
- **Cons**: larger API, slower to adopt in 22 h.
- **Why not**: Radix covers the needed widgets.

### Alternative 2: `aria-live` on each widget
- **Pros**: simple.
- **Cons**: uncontrolled noise during a storm.
- **Why not**: one announcer is testable and rate-limited.

## Consequences

### Positive
- Screen-reader-usable demo; Lighthouse ≥ 95 realistic.

### Negative
- Extra scope: pause switch and 320 px reflow are not in the PRD.

### Risks
- Radix styling must use tokens only (no inline colours).
