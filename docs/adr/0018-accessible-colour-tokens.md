# ADR-0018: Functional colour tokens separate from the PPC brand palette

**Date**: 2026-11-14
**Status**: accepted (2026-11-14, action orange `#D04000` chosen by the user)
**Deciders**: frontend dev; drafted by ecc:a11y-architect (A11Y-2..A11Y-7)

## Context

The Rețele Electrice palette fails WCAG 2.2 AA in key places (hand-computed, ±0.02): white on orange `#FF4B00` is
3.36:1, cyan `#00A0DC` on white 2.97:1, green `#00DC55` 1.85:1, yellow `#FFDA00` 1.37:1, the `#D3D5D6` input border
1.47:1, dark-blue 50 % about 3.0:1. PPC blue, dark-blue, dark-blue 75 % and grey `#555C5F` pass.

## Decision

Brand colours stay decorative. Functional tokens: `--action #D04000` (white text 4.76:1; `#C13700` at 5.50:1 was
the a11y plan's first proposal) for primary buttons; in the dark theme `#FF5A1F` with dark text (6.15:1); `--info-text #00729E` (5.38:1); `--border-input #5A5F68` (6.42:1); a two-tone focus ring (3 px dark +
white halo); status chips with icon + text: ok `#00776A` (5.46:1), warn `#FFDA00` fill with dark text and border,
bad `#B3123F` (6.83:1), neutral `#555C5F`. A Vitest test recomputes every token pair in CI. Light theme only.

## Alternatives Considered

### Alternative 1: Brand colours as-is with large or bold text
- **Pros**: exact brand look.
- **Cons**: fails 1.4.3 / 1.4.11 for normal text, inputs and focus rings.
- **Why not**: Lighthouse ≥ 95 and AA are success metrics.

### Alternative 2: Dark text on brand orange
- **Pros**: keeps the bright orange.
- **Cons**: 4.34:1, still fails.
- **Why not**: does not pass.

## Consequences

### Positive
- AA contrast everywhere; status readable for colour-vision deficiencies.

### Negative
- Primary orange is visibly darker than reteleelectrice.ro; "green cards" become status chips, not brand green.

### Risks
- Hand-computed ratios: the CI test is the source of truth.
