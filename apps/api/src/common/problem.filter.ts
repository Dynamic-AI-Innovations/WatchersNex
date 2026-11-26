import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

/** RFC 9457 problem details, the only error shape the API returns. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ field: string; message: string }>;
}

const PROBLEM_BASE = 'https://docs.watchersnex.app/problems/';

/** Thrown by application code for errors that should reach the caller as-is. */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly problemType: string,
    title: string,
    detail?: string,
    readonly fieldErrors?: Array<{ field: string; message: string }>,
  ) {
    super({ title, detail }, status);
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const problem = this.toProblem(exception);
    problem.instance = req.originalUrl?.split('?')[0];
    problem.requestId = typeof req.id === 'string' ? req.id : undefined;

    if (!(exception instanceof HttpException)) {
      // A bug: full detail goes to the log; the caller gets a generic message plus the request ID.
      this.logger.error({ err: exception, requestId: problem.requestId }, 'unhandled error');
    } else if (problem.status >= 500) {
      // A deliberate 5xx (e.g. readiness failing): worth a warning, not a stack trace.
      this.logger.warn(
        { status: problem.status, title: problem.title, requestId: problem.requestId },
        'request failed with server-side status',
      );
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ProblemException) {
      const body = exception.getResponse() as { title: string; detail?: string };
      return {
        type: PROBLEM_BASE + exception.problemType,
        title: body.title,
        status: exception.getStatus(),
        detail: body.detail,
        errors: exception.fieldErrors,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: PROBLEM_BASE + slugForStatus(status),
        title: HttpStatus[status] ? humanise(HttpStatus[status] as string) : 'Error',
        status,
        detail: status < 500 ? exception.message : undefined,
      };
    }
    return {
      type: PROBLEM_BASE + 'internal-error',
      title: 'Internal server error',
      status: 500,
      detail: 'Something went wrong on our side. Quote the request ID if you contact support.',
    };
  }
}

function slugForStatus(status: number): string {
  const name = HttpStatus[status];
  return typeof name === 'string' ? name.toLowerCase().replace(/_/g, '-') : `http-${status}`;
}

function humanise(constant: string): string {
  const words = constant.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
