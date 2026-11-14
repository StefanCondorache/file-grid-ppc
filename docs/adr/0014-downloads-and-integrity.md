# ADR-0014: Downloads only through the API; client re-verification sized by browser and file size

**Date**: 2026-11-14
**Status**: proposed (needs NestJS agreement: BA-18) — revisit: backend differs, see [backend sync](../api/backend-sync-2026-11-14.md)
**Deciders**: frontend dev; merged from ecc:security-reviewer (TM-6, TM-13), ecc:code-architect (UE-18) and ecc:architect (FA-2); resolves the stored-hash header name (`X-Content-SHA256` vs `X-File-SHA256`)

## Context

N7: the browser must never learn storage locations. F4/FE-04: a download is re-verified and corruption is shown
loudly ("Fișier corupt detectat"). A 1 GB file cannot be buffered in memory. Uploaded SVG/HTML rendered on our
origin would be XSS.

## Decision

Every download is `GET /api/v1/files/{id}/content`, streamed by NestJS with `Content-Disposition: attachment`,
`nosniff`, `application/octet-stream`, a sandbox CSP and the stored hash in `X-File-SHA256`; no presigned URLs or
redirects; `409 FILE_CORRUPT` with both hashes when detectable before streaming. Client verification: ≤ 64 MiB
buffered and hashed in any browser; larger files streamed to disk via `showSaveFilePicker` and hashed in the
worker on Chromium; otherwise a plain anchor download labelled "Verificat de server". No inline previews.

## Alternatives Considered

### Alternative 1: Presigned S3 URLs
- **Pros**: offloads bandwidth from NestJS.
- **Cons**: exposes storage location (N7); does not work for FTP or Postgres.
- **Why not**: violates the brief.

### Alternative 2: Always buffer and hash in the browser
- **Pros**: one code path.
- **Cons**: 1 GB in tab memory.
- **Why not**: violates N3 and the browser-memory metric.

## Consequences

### Positive
- Storage stays invisible; integrity proof where the browser allows it, labelled honestly elsewhere.

### Negative
- Client re-verification of large files needs Chromium.

### Risks
- A response aborted mid-body is retried; a second hash mismatch is flagged as corruption.
