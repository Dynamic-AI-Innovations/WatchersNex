import type { z } from 'zod';
import { ProblemException } from './problem.filter.js';

/** Validates a request body at the boundary; failures become RFC 9457 422s. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ProblemException(
      422,
      'validation',
      'Invalid request',
      'One or more fields are invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
