# ADR-002: TypeScript (NestJS, React with Vite) and Go for the probe

- **Status:** Accepted (G0, D-05)
- **Date:** 2026-11-26

## Context

The product team works in TypeScript. The probe needs precise network timings, a small footprint and single-binary distribution to many regions.

## Decision

NestJS for the API and worker, React with Vite for the web app, Go for the probe. The API is an ES module project (NestJS 12 and Kysely ship ES modules only); tests run on Vitest with SWC.

## Consequences

Two languages. Go is confined to one small component.
