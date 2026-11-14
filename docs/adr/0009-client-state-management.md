# ADR-0009: TanStack Query for server state, Zustand for the upload queue and app state

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; drafted by ecc:architect (FA-5, FA-6, FA-24) and ecc:code-architect (UE-17)

## Context

Server data is fetched client-side (ADR-0001) and patched by the SSE stream (ADR-0008). The upload engine is
framework-free code that must survive navigation and login, update at ~4 Hz without re-rendering the whole tree,
and be unit-testable with fake timers.

## Decision

TanStack Query owns all server state through one query-key factory; `refetchOnWindowFocus: false`,
`keepPreviousData` on lists, stream-fed keys with `staleTime: Infinity`. Zustand holds the upload store (written
only by the engine, read via selectors) and a small app store (live status, session UI, live-updates paused). The
upload engine is a module singleton in `src/lib/upload` with a command API; the tray is a read-only view.

## Alternatives Considered

### Alternative 1: SWR
- **Pros**: smaller.
- **Cons**: weaker cache manipulation for the stream bridge.
- **Why not**: `setQueryData` and targeted invalidation are central.

### Alternative 2: React context for upload state
- **Pros**: no dependency.
- **Cons**: non-React modules cannot write without a component tree; broad re-renders.
- **Why not**: Zustand is ~1 KB and solves both.

## Consequences

### Positive
- One source of server truth; engine testable in isolation; no per-byte re-renders.

### Negative
- Two state libraries to learn (both small).

### Risks
- Selector discipline needed so a progress tick re-renders only its row.
