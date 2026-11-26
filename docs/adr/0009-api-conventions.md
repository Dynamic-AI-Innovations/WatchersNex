# ADR-009: OpenAPI-first REST

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

The web app and future customer API keys must use one contract that cannot drift from the code.

## Decision

`/v1` paths scoped by organisation, RFC 9457 problem details, cursor pagination, Idempotency-Key on POST, ETag/If-Match on updates, 404 for cross-tenant IDs.

## Consequences

Error format and request IDs are implemented in the foundation (`ProblemFilter`).
