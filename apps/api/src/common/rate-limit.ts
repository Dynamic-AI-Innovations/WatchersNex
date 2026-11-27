import { ProblemException } from './problem.filter.js';

/**
 * Fixed-window, in-process rate limiter for the authentication endpoints.
 *
 * Limits are per API instance. That is adequate for one staging replica;
 * a shared Redis-backed limiter replaces it before production runs more than
 * one replica (technical debt TD-006). Account lockout, which is the stronger
 * control against password guessing, is stored in PostgreSQL and is global.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 problem details when `key` has exceeded the limit. */
  consume(key: string): void {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return;
    }
    current.count += 1;
    if (current.count > this.limit) {
      throw tooManyAttempts();
    }
  }

  private prune(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/** The same response for IP limits and account lockout, so neither reveals the other. */
export function tooManyAttempts(): ProblemException {
  return new ProblemException(
    429,
    'too-many-attempts',
    'Too many attempts',
    'Too many attempts. Wait 15 minutes and try again.',
  );
}
