# ADR-010: Severity scale and majority-quorum confirmation

- **Status:** Accepted (G0 D-07, refined at G1)
- **Date:** 2026-11-26

## Context

False alerts are the top product risk (R-01), but real regional outages must not be hidden.

## Decision

SEV1-4. An incident opens when at least 2 regions fail and at least half of the reporting regions fail, after a 15 s local retry. A one-region failure lasting 3 cycles opens a SEV3 regional-degradation incident. Recovery needs 2 consecutive successes from every failing region.

## Consequences

Single-region plans confirm on 2 consecutive failures.
