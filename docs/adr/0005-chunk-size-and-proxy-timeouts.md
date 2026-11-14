# ADR-0005: Chunk size 5–32 MiB, adaptive parallelism, raised Traefik read timeout

**Date**: 2026-11-14
**Status**: proposed (needs deploy agreement on the Traefik config)
**Deciders**: frontend dev; resolves a conflict between ecc:architect (FA-19, cap 32 MB) and ecc:code-architect (UE-6, cap 50 MiB)

## Context

Cloudflare's free plan rejects request bodies over 100 MB and cuts responses after 100 s. S3 multipart parts must
be at least 5 MiB, with at most 10,000 parts. Traefik v3's default entrypoint `readTimeout` is 60 s; an 8 MiB part
at a throttled 100 KB/s takes ~80 s. The two agents proposed different caps.

## Decision

Chunk size = `clamp(policy.chunkSize, 5 MiB, 32 MiB)`, default 8 MiB, raised by the server so `partCount ≤ 10000`;
the value returned by `POST /uploads` is authoritative and fixed for that upload. Parallelism ceiling
`clamp(policy.maxParallel, 1, 6)`, starting at 2 with AIMD. Traefik `websecure` `readTimeout` raised to 600 s,
`writeTimeout` 0, no Buffering middleware.

## Alternatives Considered

### Alternative 1: Cap at 50 MiB (code-architect)
- **Pros**: fewer requests for 1 GB.
- **Cons**: a 50 MiB part on a throttled demo link exceeds the timeouts and wastes more per retry.
- **Why not**: the demo network is the risk, not request count.

### Alternative 2: Fixed chunk size
- **Pros**: simpler.
- **Cons**: ignores the policy (F3 demo) and S3 limits.
- **Why not**: the policy editor must visibly drive it.

## Consequences

### Positive
- Every part fits Cloudflare with 3x headroom and survives slow links; retries are cheap.

### Negative
- A 1 GB file is ~128 requests at 8 MiB.

### Risks
- Traefik key names must be checked against the k3s-bundled chart (deploy owner).
