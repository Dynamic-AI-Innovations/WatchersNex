import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for sessions, CSRF, verification and reset. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as their SHA-256 hash, so a database leak can't replay them. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
