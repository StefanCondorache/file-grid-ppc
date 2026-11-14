# ADR-0003: Custom chunk upload API instead of tus

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: OQ-2)
**Deciders**: frontend dev; drafted by ecc:code-architect (UE-1, UE-4, UE-15, UE-16), merged with ecc:architect (FA-19)

## Context

Drone videos are 100 MB–1 GB+ over unstable links (N12) with constant memory on both sides (N3). The category
policy sets chunk size and max parallel chunks (BA-15, FE-06). Targets are S3 (multipart), FTP and Postgres. The
mock must simulate the protocol (D7). Cloudflare caps a request at 100 MB and 100 s.

## Decision

Five plain endpoints: `POST /uploads` (idempotent via `Idempotency-Key`), `PUT /uploads/{id}/parts/{n}` (raw bytes,
`X-Part-SHA256`, idempotent), `GET /uploads/{id}` (received ranges, status, result), `POST /uploads/{id}/complete`
(client SHA-256), `DELETE /uploads/{id}`, plus `HEAD /ping`. The server verifies each part while streaming, then
computes the whole-file SHA-256 by reading parts back in order at `complete`. `complete` answers `200` with the
verdict (a mismatch is `200` with `verdict: mismatch`, `fileId: null`) or `202` + `Retry-After`; on `202` the
client polls `GET /uploads/{id}` and treats the SSE `upload.verified` event as a hint to poll immediately.

## Alternatives Considered

### Alternative 1: tus (`tus-js-client` + `@tus/server`)
- **Pros**: standard, resumable out of the box.
- **Cons**: core is sequential PATCH; parallelism needs the concatenation extension with N fixed at start; custom
  DataStores for FTP and Postgres; BA-65 and the policy snapshot through hooks.
- **Why not**: the policy's parallelism field would be ignored, and the backend must learn tus internals.

### Alternative 2: Always-asynchronous completion via SSE only (architect's first draft)
- **Pros**: never hits the 100 s limit.
- **Cons**: small files wait for a stream event; depends on the stream being up.
- **Why not**: merged: `200` when fast, `202` + poll when slow, SSE only as an accelerator.

## Consequences

### Positive
- Native parallel parts; 1:1 with S3 multipart; trivial to mock; plain NestJS controllers.

### Negative
- We own the protocol: status and error codes become contract (OpenAPI proposal).
- One extra sequential read of the file at `complete`.

### Risks
- FTP/Postgres targets need disk staging on the VPS (backend to confirm space).
