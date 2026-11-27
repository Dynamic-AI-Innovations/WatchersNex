import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/**
 * All runtime configuration comes from environment variables and is validated
 * once at start-up. The process refuses to start with invalid configuration
 * rather than failing later at first use.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Reverse proxies in front of the API whose X-Forwarded-For entries are
   * trusted for the client IP: 1 for Railway's edge alone, 2 when the web
   * app's Vercel rewrite also sits in front.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Public URL of the web app; links in emails point here. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  /** Secure cookies need HTTPS. Only local development and tests turn this off. */
  SESSION_COOKIE_SECURE: bool.default(true),
  /** Requests per minute per IP on each sign-in, sign-up and reset endpoint. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Failed logins before an account is locked for 15 minutes. */
  LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).default(10),

  /** 'log' writes emails to the log (no delivery); 'postmark' sends them. */
  EMAIL_TRANSPORT: z.enum(['log', 'postmark']).default('log'),
  /**
   * With the log transport, include verification and reset links in the log.
   * Only for environments without real users: a link in a log is a credential.
   */
  EMAIL_LOG_LINKS: bool.default(false),
  POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  EMAIL_FROM: z.string().default('WatchersNex <no-reply@localhost>'),
}).superRefine((config, ctx) => {
  if (config.EMAIL_TRANSPORT === 'postmark' && !config.POSTMARK_SERVER_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['POSTMARK_SERVER_TOKEN'], message: 'required when EMAIL_TRANSPORT=postmark' });
  }
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Name the variables only: values may be secrets.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
