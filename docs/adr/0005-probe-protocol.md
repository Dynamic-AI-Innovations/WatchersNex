# ADR-005: Probe-side scheduling with pull config and push results

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

A central scheduler is a single point of failure; probes must keep checking during a core outage.

## Decision

Probes hold their schedule, pull config every 30 s, push signed result batches (Ed25519 per probe), long-poll for verification requests, and buffer up to 24 hours on disk. No inbound ports.

## Consequences

Results are idempotent by (monitor, probe, scheduled time, attempt). Late results fill history but never open incidents retroactively.
