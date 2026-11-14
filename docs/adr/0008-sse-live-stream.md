# ADR-0008: Server-Sent Events for live updates, with snapshot resync and heartbeat

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: OQ-9)
**Deciders**: frontend dev; ecc:architect (FA-7, FA-8, FA-9) and ecc:security-reviewer (TM-5) agree

## Context

Beats 1, 3 and 5 need live counters, guarantee status, alerts, storage health and new fault records (BA-60). The
path is browser → Cloudflare (100 s idle cutoff) → Traefik → NestJS, authenticated by an httpOnly cookie. Only
server→client push is needed.

## Decision

One SSE connection per tab at `GET /api/v1/stream`. Headers `text/event-stream`, `Cache-Control: no-cache,
no-transform`, `X-Accel-Buffering: no`; `retry: 3000`; a named `ping` event every 20 s; monotonic `id:`; events
filtered by the active role; high-rate counters coalesced to ≤ 2/s. Events are snapshots or hints: on every
(re)connect the client refetches stream-fed queries over REST. Client watchdog (45 s without events → reconnect)
and its own jittered 1–30 s backoff after a non-200. Metrics (matrix, bulkhead) are polled every 5 s instead.

## Alternatives Considered

### Alternative 1: WebSocket
- **Pros**: bidirectional.
- **Cons**: upgrade handling through Traefik/Cloudflare; CSWSH needs an Origin check; hand-written reconnect.
- **Why not**: no client→server messages are needed.

### Alternative 2: Polling only
- **Pros**: simplest server.
- **Cons**: "appears without refresh" (beat 3) feels laggy; more load during a storm.
- **Why not**: SSE is cheap in NestJS (`@Sse()`).

## Consequences

### Positive
- Cookie auth and reconnect built in; easy to mock with MSW `sse()`; correct after any gap thanks to resync.

### Negative
- NestJS must emit pings and filter per role; `Last-Event-ID` replay is best-effort only.

### Risks
- Cloudflare or Traefik buffering would freeze the stream: `no-transform` and no Buffering middleware are required.
