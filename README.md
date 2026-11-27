# WatchersNex

Digital reliability and operations intelligence platform by Dynamics Technology.
*Complete Visibility. Intelligent Control.* (Name provisional, pending legal clearance.)

**Licence:** proprietary, all rights reserved (see [LICENSE](LICENSE)). Visible publicly, not open source.

**Status:** Phase 3, engineering foundation. Staging deployed: accounts, sessions and organisations work; monitoring not built yet.

## Source of truth

| Document | Purpose |
| --- | --- |
| [Project Kickoff Package](https://claude.ai/artifact/QPyMWBHCYNLzWckHEsUKN3) | Approved MVP scope, requirements traceability, backlog, roadmap, registers (G0) |
| [Technical Architecture and System Design](https://claude.ai/artifact/9KrUYdg1vnN6EMkxH4grrU) | Schema, API, auth, probe protocol, threat model, hosting (G1) |
| [`docs/adr/`](docs/adr) | Architecture decision records, ADR-001 to ADR-010 |

## Repository layout

```
apps/api      NestJS API and worker (TypeScript, ES modules)
  migrations  SQL migrations (node-pg-migrate)
  test        Vitest suites against a real PostgreSQL
apps/web      React + Vite web app        (next: Phase 3 / WP-02 designs)
apps/probe    Go probe agent              (Phase 4 / WP-04)
docs/adr      Architecture decision records
```

## Develop

Requirements: Node.js 24 (`.nvmrc`), pnpm 9.

```sh
pnpm install
pnpm --filter @watchersnex/api test       # starts an embedded PostgreSQL 18 automatically
pnpm --filter @watchersnex/api typecheck
pnpm --filter @watchersnex/api build
```

To run against your own database, copy `apps/api/.env.example` to `.env`, then
`pnpm db:migrate` and `node apps/api/dist/main.js`. Set `TEST_DATABASE_URL` to
point the tests at an existing PostgreSQL instead of the embedded one (CI does this).

## Engineering rules

- Every tenant query runs inside `withTenant()`, so row-level security applies. Never query tenant tables outside it.
- Errors leave the API only as RFC 9457 problem details, with a request ID.
- Secrets never appear in logs, responses, results or exports.
- A feature is done when backend, frontend, data, permissions, validation, error handling and tests all work together.
