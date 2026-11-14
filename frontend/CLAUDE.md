# frontend/: working rules

**Read [docs/frontend/context.md](../docs/frontend/context.md) first, every session.** It holds the requirements,
the data categories, the team constraints and the PPC design facts. The source of truth for requirements is
[docs/brief/FileGrid_PPC.pdf](../docs/brief/FileGrid_PPC.pdf). `TASKS.md` is an example, not a spec.

## Scope

- Only edit `frontend/` and `docs/frontend/` unless asked. For anything else (`infra/`, `deploy/`, `Makefile`,
  `README.md`, backend code), propose the change and wait.
- The REST contract with the NestJS backend is not fixed. Never hard-code endpoint shapes in components: go
  through the typed API client layer and record every assumption as a "backend ask".

## Stack

- Next.js (App Router), React, TypeScript in `strict` mode.
- Deployed as a container in k3s (namespace `filegrid`) behind Traefik on `https://ppc.filegrid.cc.cd`.
- Other libraries are chosen in the PRD, the ADRs and the plan. Do not add a dependency they do not call for.

## Commands

To be filled in when the app is scaffolded.

| Task | Command |
|---|---|
| Install | TBD |
| Dev server | TBD |
| Build | TBD |
| Start (production) | TBD |
| Lint | TBD |
| Typecheck | TBD |
| Unit tests | TBD |
| E2E tests | TBD |
| Generate API types | TBD |
| Docker image | TBD |

## Conventions

- **Romanian UI copy, English code.** Every user-visible string is Romanian with correct diacritics: ă â î ș ț
  (Ș Ț). Use comma-below ș ț (U+0219 / U+021B, U+0218 / U+021A), never cedilla ş ţ (U+015F / U+0163).
  Identifiers, file names, comments, commit messages and logs are English.
- **No secrets in the repo.** Commit only `.env.example` with placeholders. Nothing secret in `NEXT_PUBLIC_*`
  (it ships to the browser). Storage URLs and credentials never reach the frontend.
- **Uploads never stream through the Next.js server.** File bytes go from the browser straight to the NestJS
  API; downloads come straight from it too. No Route Handler, Server Action or rewrite proxies file bodies.
  In the browser, read files in `Blob.slice` chunks, never whole. (Brief: 1 GB+ files at constant memory, on a
  4 GB VPS.)
- **All colours come from design tokens.** No hex, `rgb()`, `hsl()` or named colours, and no arbitrary Tailwind
  colour values in components or charts. Reference the token CSS variables only; add a token if one is missing.
- **Memory limit.** The frontend container always runs with explicit memory requests and limits.
- **Brand.** It should feel like a Rețele Electrice internal tool, but never use PPC or Rețele Electrice logos
  and never present FileGrid as an official PPC product.
