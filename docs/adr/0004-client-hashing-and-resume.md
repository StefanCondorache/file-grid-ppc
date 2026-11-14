# ADR-0004: Hash-first SHA-256 in a Web Worker; resume from IndexedDB and file handles

**Date**: 2026-11-14
**Status**: proposed
**Deciders**: frontend dev; drafted by ecc:code-architect (UE-2, UE-3, UE-11..UE-14), constrained by ecc:security-reviewer (TM-10)

## Context

F4 requires the client SHA-256 to be compared with the server's. WebCrypto cannot hash incrementally, and a 1 GB
file must never be held in memory. Beat 2 reloads the page mid-upload (OQ-1) and must continue from the last
confirmed part. Connection documents carry personal data that must not persist in the browser.

## Decision

Hash the whole file once, first, in a Web Worker with `hash-wasm` (incremental), computing per-part SHA-256 with
`crypto.subtle.digest` in the same pass; then upload parts in parallel. Persist an allow-listed record in IndexedDB
(upload ID, idempotency key, part hashes, confirmed-part bitset, real user ID; no PII, no bytes). After reload,
reopen the file from a stored `FileSystemFileHandle` on Chromium (0–1 click); otherwise ask once to re-select and
verify by fingerprint plus sampled part hashes. Connection documents store no file name and no handle, and always
re-select.

## Alternatives Considered

### Alternative 1: Hash while uploading
- **Pros**: no upfront wait.
- **Cons**: parallel parts arrive out of order; resume would need hasher checkpoints.
- **Why not**: hash-first (est. 3–8 s/GB) makes resume trivial.

### Alternative 2: Store the `File` object in IndexedDB
- **Pros**: no permission prompt.
- **Cons**: may copy the bytes into IndexedDB (unverified, low confidence).
- **Why not**: risks GB-sized storage and persisting personal documents.

## Consequences

### Positive
- Reload never re-hashes; per-part checksums known before sending; constant memory.

### Negative
- A visible "se calculează amprenta" phase before bytes move; CSP needs `'wasm-unsafe-eval'` (ADR-0012).

### Risks
- Chrome may not keep "Allow on every visit" for the handle, so beat 2 may need one click (narrate it as the
  identity check). hash-wasm throughput to be benchmarked on the demo laptop.
