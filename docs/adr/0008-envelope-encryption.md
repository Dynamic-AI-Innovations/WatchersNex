# ADR-008: Envelope encryption for secrets

- **Status:** Accepted (G1)
- **Date:** 2026-11-26

## Context

Monitor secrets and TOTP seeds must be unreadable from a database dump.

## Decision

AES-256-GCM with a per-record data key, wrapped by an AWS KMS key per environment.

## Consequences

KMS becomes a runtime dependency for secret reads; data keys are cached briefly in memory.
