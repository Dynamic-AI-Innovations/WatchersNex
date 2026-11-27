import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.filter.js';
import { APP_CONFIG, AppConfig } from '../config/config.js';
import { AuthService, RequestMeta, ResolvedSession } from './auth.service.js';
import { cookieNames } from './cookies.js';

export type AuthedRequest = Request & { auth?: ResolvedSession };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Requires a valid session. For state-changing methods it also requires the
 * CSRF double-submit token: the X-CSRF-Token header must equal the CSRF cookie,
 * which a page on another site can't read.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const names = cookieNames(this.config);
    const token: unknown = req.cookies?.[names.session];
    const session = typeof token === 'string' && token.length > 0 ? await this.auth.resolveSession(token) : null;
    if (!session) {
      throw new ProblemException(401, 'unauthenticated', 'Sign-in required', 'Sign in to continue.');
    }

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.get('x-csrf-token');
      const cookie: unknown = req.cookies?.[names.csrf];
      if (!header || typeof cookie !== 'string' || !sameToken(header, cookie)) {
        throw new ProblemException(403, 'csrf', 'Request blocked', 'The request is missing a valid CSRF token. Reload the page and try again.');
      }
    }

    req.auth = session;
    return true;
  }
}

/** The authenticated session, set by AuthGuard. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const session = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!session) throw new Error('CurrentSession used on a route without AuthGuard');
  return session;
});

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}
