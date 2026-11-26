# ADR-003: PostgreSQL with forced row-level security and partitioned results

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

Tenant isolation (FR-003) must not depend on every query remembering a WHERE clause.

## Decision

Every tenant table has `organisation_id`, RLS enabled and forced, and a policy against `wnx_current_org()`. Tenant transactions run `SET LOCAL ROLE wnx_app` (NOBYPASSRLS) and set `app.current_org` locally. In production the API connects as a dedicated login role that is a member of `wnx_app`, never as a superuser. Check results are range-partitioned by day.

## Consequences

Proven by `apps/api/test/tenant-isolation.test.ts`. Removing the role guard makes 5 of 7 isolation tests fail, because superusers bypass RLS.
