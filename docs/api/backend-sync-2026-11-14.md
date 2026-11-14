# Backend sync: what the teammates' code changes for the frontend (2026-11-14)

*Reviewed: `origin/main` (P1 infra, storage adapters in Python, k8s app manifests, README "Contracte pentru P2/P3")
and `origin/feat/p2-backend-nest` (P2 NestJS 12 skeleton: auth, schema, error filter, tracing). Compared with our
[OpenAPI proposal](openapi.frontend-proposal.yaml), [handoff](HANDOFF-backend.md) and [ADRs](../adr/README.md).
Nothing in the backend was changed.*

> **Status: provisional (2026-11-14).** The backend team has not decided its final approach yet, so nothing below is
> adopted. The frontend stays on its own proposal and mocks; the API client isolates paths, error envelope, header
> names and label maps so whichever backend lands is one adapter per endpoint group. Revisit this note when they decide.

## Would adopt if the current NestJS skeleton stays

| Topic | Backend reality | Our proposal | Frontend action | ADR |
|---|---|---|---|---|
| Base path | Controllers at `api/...`, no version (`/api/auth/login`) | `/api/v1` | Use `/api`; drop `v1` | 0002 |
| Error body | `{ "error": { code, message, trace_id, details } }`, codes lower snake (`unauthorized`, `validation_error`) | flat `{ code UPPER, message, traceId, fieldErrors }` | Parse their envelope in `ApiError`; map codes to Romanian copy (their `message` is English) | 0010 |
| Trace header | `X-Trace-Id` echoed; a valid client-sent ID is reused | same | Send our own `X-Trace-Id` per upload so the trace view links client → server | 0010 |
| Stored-hash header | `X-Content-SHA256` (exposed) | `X-File-SHA256` | Use `X-Content-SHA256` | 0014 |
| Storage labels | `s3`, `ftp`, `db` (lower case) | `S3`/`FTP`/`DB` | Map to display labels in the UI | — |
| Chunk limits | 64 KiB – 64 MiB (code); README: Traefik `readTimeout` 900 s, chunks 1–5 MB, Cloudflare **DNS-only** (no 100 MB proxy cap) | 5–32 MiB, default 8 | Policy decides; default UI expectation 4 MiB; keep ≤ 32 MiB clamp | 0005 |
| Upload status values | `active / completing / completed / aborted`; chunk index 0-based (`upload_chunks.chunk_index`) | `open / verifying / …`, 1-based parts | Map states; use their indexing once endpoints exist | 0003 |
| Grafana | Live at `/grafana`, dashboard `/grafana/d/filegrid-overview` | optional | "Deschide în Grafana" links become real | — |
| Storage stop/start | Backend service account may scale storage StatefulSets 0↔1 (`demo-rbac.yaml`) | teammate's terminal (PRD D2) | Control room can offer "Oprește / Pornește S3" buttons (mockup 04) if P2 exposes it | 0015 |
| Frontend container | k8s expects image `filegrid-frontend`, port 8080, uid 101, limit **128Mi** | Next standalone, 256Mi | Run Next on `PORT=8080` as uid 101; **ask P1 to raise the limit to 256Mi** (Node standalone idles ~70–110 Mi) | 0020 |

## Needs a team decision (blocking, conflicts with PRD or ADRs)

1. **Auth transport.** Backend returns a JWT in the login body (`access_token`, bearer header, 8 h TTL). Our ADR-0006
   chose an httpOnly cookie because `EventSource` (live stream) and plain download links cannot send an
   `Authorization` header, and a 1 GB download through `fetch` would sit in browser memory. Options: (a) backend also
   sets the JWT as `__Host-` httpOnly cookie and the guard accepts cookie or bearer (recommended, small change);
   (b) keep bearer and use short-lived signed URLs for stream and downloads (more work, URLs in logs).
2. **Roles.** *(Frontend decision 2026-11-14: login by role dropdown, five demo accounts, ADR-0022.)* Backend has `admin` and `operator`; PRD D4 has five roles (teren, dispecerat, racordari, auditor,
   admin) and beat 4 needs `racordari` vs `auditor` for the PII proof. Either the backend adds the five roles, or the
   PRD and demo script shrink to two roles (beat 4 then shows only admin vs operator).
3. **Category identifiers.** Three spellings exist: P1 README/metrics `meter_readings, fault_records,
   connection_documents, drone_videos`; P2 code `meter_reading, fault_record, connection_doc, drone_video`; our
   proposal `meter, fault, connection, drone`. The frontend will use whatever the API returns, but P1 and P2 must
   agree because dashboards and alerts filter on these labels.
4. **OpenAPI document.** The NestJS project has no `@nestjs/swagger`; ADR-0010 relies on generated types. Either P2
   adds it (≈15 min, `/api/docs-json`), or the frontend keeps hand-written types from this proposal.
5. **Stack drift.** Storage adapters and crypto on `main` are Python (FastAPI-oriented README), the API branch is
   NestJS. How does NestJS call the Python adapters? (Affects upload streaming and N3 memory, not the UI.)
6. **Missing data for the demo.** The schema has no operation-log spans (trace waterfall, metrics matrix,
   statistics), no `origin` tag (manual/simulator/storm/seed), no labelled periods (S2) and no guarantee thresholds.
   These are PRD BA-20, BA-43/44, BA-51, BA-64, BA-40; the frontend stays on mocks for them until they exist.

## Effect on frontend work now

Nothing blocks the design or the mock-first build. The API client must isolate these differences (envelope parser,
label maps, path prefix) so switching to the real API is one module per endpoint group. ADRs 0002, 0003, 0005, 0006,
0010, 0014, 0020 are flagged "revisit" until the team answers the six questions above.
