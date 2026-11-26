import { ArgumentsHost, ServiceUnavailableException } from '@nestjs/common';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException, ProblemFilter } from '../src/common/problem.filter.js';

function harness() {
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  };
  const req = { id: 'req-12345678', originalUrl: '/v1/orgs/x/monitors?secret=1' };
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { filter: new ProblemFilter(logger), logger, sent, host };
}

describe('ProblemFilter', () => {
  it('hides the message of an unexpected error and logs it in full', () => {
    const { filter, logger, sent, host } = harness();
    filter.catch(new Error('connection to 10.0.0.5 failed: password authentication'), host);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('10.0.0.5');
    expect(sent.body).toMatchObject({ status: 500, requestId: 'req-12345678' });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('drops the query string from instance, which may carry sensitive values', () => {
    const { filter, sent, host } = harness();
    filter.catch(new Error('x'), host);
    expect(sent.body?.instance).toBe('/v1/orgs/x/monitors');
  });

  it('logs a deliberate 5xx as a warning without a stack trace', () => {
    const { filter, logger, sent, host } = harness();
    filter.catch(new ServiceUnavailableException('Database is not reachable'), host);
    expect(sent.status).toBe(503);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('passes application problems through with field errors', () => {
    const { filter, sent, host } = harness();
    filter.catch(
      new ProblemException(422, 'validation', 'Invalid monitor', 'Check the fields', [
        { field: 'target', message: 'must be a public http(s) URL' },
      ]),
      host,
    );
    expect(sent.body).toMatchObject({
      type: 'https://docs.watchersnex.app/problems/validation',
      status: 422,
      errors: [{ field: 'target', message: 'must be a public http(s) URL' }],
    });
  });
});
