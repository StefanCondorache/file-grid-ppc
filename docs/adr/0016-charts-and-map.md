# ADR-0016: Recharts (lazy) + own SVG sparklines and region map, every chart with a data table

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; ecc:architect (FA-14, FA-15) and ecc:a11y-architect (A11Y-19, A11Y-20) agree

## Context

Beats 5 and 8 need a bulkhead latency chart, S1/S2 comparisons and an S3 map. All colours must come from tokens
(CSS variables). Every chart needs a data-table alternative and must not rely on colour alone. Bundle and build
time matter.

## Decision

Recharts, loaded with `next/dynamic` only on `/observability`, `/statistics`, `/meters` and `/demo`; colours as
`var(--token)` on SVG attributes; dash patterns and direct labels per series; animation off under reduced motion;
React-rendered text tooltips only. Hand-written SVG sparklines. A hand-simplified static SVG map of Muntenia,
Banat and Dobrogea. Every chart sits in `ChartFigure` (title, Romanian interpretation, `<details>` table from the
same data array). The category × storage matrix and trace waterfall are real `<table>`s.

## Alternatives Considered

### Alternative 1: Canvas libraries (uPlot, Chart.js, ECharts)
- **Pros**: fast, small (uPlot).
- **Cons**: CSS variables need `getComputedStyle`; canvas is opaque to screen readers; ECharts is >300 KB.
- **Why not**: token rule and accessibility.

### Alternative 2: visx / d3
- **Pros**: full control.
- **Cons**: axes and tooltips by hand.
- **Why not**: too slow to build in 22 h.

## Consequences

### Positive
- Token-driven, accessible charts with little code; no geo dependency.

### Negative
- ~100 KB gz on chart routes.

### Risks
- County-level map (OQ-6) would need offline-generated paths.
