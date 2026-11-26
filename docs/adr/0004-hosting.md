# ADR-004: Railway (Europe) core; probes on AWS and Hetzner in 4 regions

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

The platform must not share a failure domain with its own monitoring, and needs global vantage points.

## Decision

Core API, worker, PostgreSQL (HA plus point-in-time recovery) and Redis on Railway, Europe. Probes: AWS Cape Town and Singapore; Hetzner Germany and Ashburn. AWS KMS for envelope encryption. Web app on a CDN.

## Consequences

No provider holds a majority of probe regions. Customer data is stored in the EU under a DPA with standard contractual clauses.
