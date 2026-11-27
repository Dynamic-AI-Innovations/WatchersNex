import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiter } from '../common/rate-limit.js';
import { parseBody } from '../common/validation.js';
import { APP_CONFIG, AppConfig } from '../config/config.js';
import { OrgsService } from '../tenancy/orgs.service.js';
import {
  AuthService,
  emailOnlySchema,
  loginSchema,
  registerSchema,
  ResolvedSession,
  resetSchema,
  tokenSchema,
} from './auth.service.js';
import { AuthGuard, CurrentSession, requestMeta } from './auth.guard.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';

const ACCEPTED = {
  status: 'accepted',
  detail: 'If the details are valid, we have sent an email with the next step.',
} as const;

@Controller()
export class AuthController {
  private readonly limiters: Record<'register' | 'login' | 'verify' | 'forgot' | 'reset', RateLimiter>;

  constructor(
    private readonly auth: AuthService,
    private readonly orgs: OrgsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const perMinute = config.AUTH_RATE_LIMIT_PER_MINUTE;
    this.limiters = {
      register: new RateLimiter(perMinute),
      login: new RateLimiter(perMinute),
      verify: new RateLimiter(perMinute),
      forgot: new RateLimiter(perMinute),
      reset: new RateLimiter(perMinute),
    };
  }

  @Post('auth/register')
  @HttpCode(202)
  async register(@Body() body: unknown, @Req() req: Request) {
    this.limiters.register.consume(req.ip ?? 'unknown');
    await this.auth.register(parseBody(registerSchema, body), requestMeta(req));
    return ACCEPTED;
  }

  @Post('auth/verify-email')
  @HttpCode(204)
  async verifyEmail(@Body() body: unknown, @Req() req: Request): Promise<void> {
    this.limiters.verify.consume(req.ip ?? 'unknown');
    await this.auth.verifyEmail(parseBody(tokenSchema, body).token, requestMeta(req));
  }

  @Post('auth/verify-email/resend')
  @HttpCode(202)
  async resendVerification(@Body() body: unknown, @Req() req: Request) {
    this.limiters.verify.consume(req.ip ?? 'unknown');
    await this.auth.resendVerification(parseBody(emailOnlySchema, body).email);
    return ACCEPTED;
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limiters.login.consume(req.ip ?? 'unknown');
    const result = await this.auth.login(parseBody(loginSchema, body), requestMeta(req));
    setSessionCookies(res, this.config, result.sessionToken, result.csrfToken);
    return { user: result.user };
  }

  @Post('auth/logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@CurrentSession() session: ResolvedSession, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(session, requestMeta(req));
    clearSessionCookies(res, this.config);
  }

  @Post('auth/password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Req() req: Request) {
    this.limiters.forgot.consume(req.ip ?? 'unknown');
    await this.auth.forgotPassword(parseBody(emailOnlySchema, body).email, requestMeta(req));
    return ACCEPTED;
  }

  @Post('auth/password/reset')
  @HttpCode(204)
  async reset(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.limiters.reset.consume(req.ip ?? 'unknown');
    await this.auth.resetPassword(parseBody(resetSchema, body), requestMeta(req));
    clearSessionCookies(res, this.config);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentSession() session: ResolvedSession) {
    return { user: session.user, organisations: await this.orgs.listForUser(session.user.id) };
  }
}
