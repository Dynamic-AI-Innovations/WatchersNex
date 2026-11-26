# ADR-006: In-house server-side sessions

- **Status:** Accepted (G0, D-06)
- **Date:** 2026-11-26

## Context

Sessions must be revocable instantly; enterprise SSO comes later.

## Decision

argon2id passwords, `__Host-` httpOnly cookies holding a random token stored only as a SHA-256 hash, CSRF double-submit, TOTP MFA. SSO via a specialist provider at the enterprise tier.

## Consequences

The team owns the security of the auth code; it is covered by the external penetration test.
