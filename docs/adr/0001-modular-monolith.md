# ADR-001: Modular monolith plus a separate probe agent

- **Status:** Accepted (G0, D-05)
- **Date:** 2026-11-26

## Context

The MVP is a scheduling, evaluation and alerting problem at pilot scale. Microservices would add network failure modes and operating effort without a scaling need.

## Decision

One TypeScript codebase deployed as two processes (`api`, `worker`), plus a Go probe agent. Ten modules own their own tables and talk through exported services and outbox events.

## Consequences

Any module can be split out later if load demands it. Cross-module table access is forbidden by convention and review.
