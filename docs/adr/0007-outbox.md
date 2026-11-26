# ADR-007: Transactional outbox for domain events

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

Events must never be lost when Redis is briefly unavailable, nor sent for changes that rolled back.

## Decision

Events are written to `outbox` in the same transaction as the change; a relay publishes them to Redis queues.

## Consequences

At-least-once delivery; consumers are idempotent.
