import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Accept a caller's X-Request-Id only when it is a safe token, so request IDs
 * can't be used to inject content into logs. Otherwise generate one.
 */
export function resolveRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}
