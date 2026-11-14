# ADR-0017: Typed message catalogue without an i18n library, plus a cedilla lint

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; drafted by ecc:architect (FA-16, FA-17)

## Context

Romanian is the only P0 language; English is P2 but strings must live in one catalogue (FE-16). Correct
comma-below ș ț are a success metric ("0 cedilla"). Romanian plurals need the "de" form ("20 de fișiere").

## Decision

`lib/i18n/ro.ts` is a nested `as const` object with function interpolations; `useT()` returns it; `en.ts` (P2) is
`satisfies Catalog`. `Intl.PluralRules('ro')`, `Intl.NumberFormat('ro-RO')`, `Intl.DateTimeFormat('ro-RO',
Europe/Bucharest)`. `scripts/check-diacritics.mjs` fails lint/CI on U+015E/015F/0162/0163 anywhere in `src`,
`mocks` and `tests`.

## Alternatives Considered

### Alternative 1: next-intl
- **Pros**: mature, ICU messages.
- **Cons**: locale routing and middleware decisions for one language.
- **Why not**: unnecessary at P0.

### Alternative 2: ESLint regex on string literals only
- **Pros**: editor feedback.
- **Cons**: misses JSON seed data and comments.
- **Why not**: kept optional; the script is the gate.

## Consequences

### Positive
- Fully typed keys; missing English keys fail `tsc`.

### Negative
- No ICU message syntax; complex plurals are hand-written functions.

### Risks
- None significant.
