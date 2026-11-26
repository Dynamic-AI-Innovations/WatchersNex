import pino, { Logger } from 'pino';

/**
 * Paths that must never reach logs. Monitor secrets, session cookies and
 * credentials are removed before serialisation (threat T-04).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.secrets',
  '*.headers.authorization',
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'watchersnex-api' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
