import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import { LOGGER } from '../common/logger.js';
import { ProblemException } from '../common/problem.filter.js';
import { tooManyAttempts } from '../common/rate-limit.js';
import { hashToken, newToken } from '../common/tokens.js';
import { APP_CONFIG, AppConfig } from '../config/config.js';
import { Db, isUniqueViolation, Tx, withAppRole } from '../db/database.js';
import { DB } from '../db/database.module.js';
import { EMAIL_SENDER, EmailMessage, EmailSender } from '../email/email.js';
import { SESSION_ABSOLUTE_MS } from './cookies.js';
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from './passwords.js';

const MINUTE = 60_000;
const SESSION_IDLE_MS = 12 * 60 * MINUTE;
const SESSION_TOUCH_MS = 5 * MINUTE;
const LOCK_MS = 15 * MINUTE;
const VERIFY_TTL_MS = 24 * 60 * MINUTE;
const RESET_TTL_MS = 30 * MINUTE;

const email = z.string().trim().toLowerCase().email('must be a valid email address').max(254);

export const registerSchema = z
  .object({ email, name: z.string().trim().min(1).max(200), password: passwordSchema })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    path: ['password'],
    message: 'must not be your email address',
  });
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const emailOnlySchema = z.object({ email });
export const tokenSchema = z.object({ token: z.string().min(20).max(100) });
export const resetSchema = z.object({ token: z.string().min(20).max(100), password: passwordSchema });
export const profileSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

function invalidCredentials(): ProblemException {
  return new ProblemException(401, 'invalid-credentials', 'Sign-in failed', 'The email or password is incorrect.');
}

function invalidToken(): ProblemException {
  return new ProblemException(400, 'invalid-token', 'Link not valid', 'This link is invalid or has expired. Request a new one.');
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Always resolves the same way, whether or not the email is registered, so
   * the endpoint can't be used to discover accounts. An existing owner is told
   * by email instead.
   */
  async register(input: z.infer<typeof registerSchema>, meta: RequestMeta): Promise<void> {
    const passwordHash = await hashPassword(input.password);
    const existing = await withAppRole(this.db, (tx) =>
      tx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst(),
    );
    if (existing) {
      await this.deliver({
        kind: 'account-exists',
        to: input.email,
        subject: 'Your WatchersNex account',
        text: 'Someone tried to create a WatchersNex account with this email address. You already have an account. If this was you, sign in or reset your password. If not, you can ignore this email.',
      });
      return;
    }

    const userId = randomUUID();
    const token = newToken();
    try {
      await withAppRole(this.db, async (tx) => {
        await tx
          .insertInto('users')
          .values({ id: userId, email: input.email, name: input.name, password_hash: passwordHash })
          .execute();
        await this.issueToken(tx, userId, 'verify_email', token, VERIFY_TTL_MS);
        await this.audit(tx, userId, 'user.registered', meta);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // concurrent sign-up with the same email
      throw error;
    }
    await this.sendVerification(input.email, token);
  }

  async resendVerification(address: string): Promise<void> {
    const token = newToken();
    const user = await withAppRole(this.db, async (tx) => {
      const found = await tx
        .selectFrom('users')
        .select(['id', 'email'])
        .where('email', '=', address)
        .where('email_verified_at', 'is', null)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (found) await this.issueToken(tx, found.id, 'verify_email', token, VERIFY_TTL_MS);
      return found;
    });
    if (user) await this.sendVerification(user.email, token);
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    await withAppRole(this.db, async (tx) => {
      const userId = await this.consumeToken(tx, 'verify_email', token);
      await tx
        .updateTable('users')
        .set({ email_verified_at: new Date() })
        .where('id', '=', userId)
        .where('email_verified_at', 'is', null)
        .execute();
      await this.audit(tx, userId, 'user.email_verified', meta);
    });
  }

  async login(
    input: z.infer<typeof loginSchema>,
    meta: RequestMeta,
  ): Promise<{ sessionToken: string; csrfToken: string; user: SessionUser }> {
    const user = await withAppRole(this.db, (tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'email', 'name', 'password_hash', 'email_verified_at', 'status', 'locked_until', 'is_platform_admin'])
        .where('email', '=', input.email)
        .executeTakeFirst(),
    );
    if (!user) {
      await burnPasswordCheck(input.password);
      throw invalidCredentials();
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw tooManyAttempts();
    }

    if (!(await verifyPassword(user.password_hash, input.password))) {
      const lockedNow = await this.recordFailedLogin(user.id, meta);
      if (lockedNow) {
        await this.deliver({
          kind: 'account-locked',
          to: user.email,
          subject: 'Your WatchersNex account was locked',
          text: 'Your account was locked for 15 minutes after repeated failed sign-in attempts. If this wasn\'t you, reset your password when the lock ends.',
        });
      }
      throw invalidCredentials();
    }
    if (user.status !== 'active') throw invalidCredentials();
    if (!user.email_verified_at) {
      throw new ProblemException(
        403,
        'email-not-verified',
        'Email not verified',
        'Verify your email address before signing in. Check your inbox, or request a new link.',
      );
    }

    const sessionToken = newToken();
    await withAppRole(this.db, async (tx) => {
      await tx
        .updateTable('users')
        .set({ failed_login_count: 0, locked_until: null })
        .where('id', '=', user.id)
        .execute();
      await tx
        .insertInto('sessions')
        .values({
          id: randomUUID(),
          user_id: user.id,
          token_hash: hashToken(sessionToken),
          ip: meta.ip,
          user_agent: meta.userAgent?.slice(0, 512) ?? null,
          expires_at: new Date(Date.now() + SESSION_ABSOLUTE_MS),
        })
        .execute();
      await this.audit(tx, user.id, 'user.login', meta);
    });
    return {
      sessionToken,
      csrfToken: newToken(),
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.is_platform_admin },
    };
  }

  /** Returns the session's user, or null when the session is unknown, revoked, idle or expired. */
  async resolveSession(sessionToken: string): Promise<ResolvedSession | null> {
    return withAppRole(this.db, async (tx) => {
      const row = await tx
        .selectFrom('sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select(['s.id as sessionId', 's.last_seen_at', 'u.id', 'u.email', 'u.name', 'u.is_platform_admin'])
        .where('s.token_hash', '=', hashToken(sessionToken))
        .where('s.revoked_at', 'is', null)
        .where('s.expires_at', '>', new Date())
        .where('u.status', '=', 'active')
        .executeTakeFirst();
      if (!row) return null;

      const idleFor = Date.now() - row.last_seen_at.getTime();
      if (idleFor > SESSION_IDLE_MS) {
        await tx.updateTable('sessions').set({ revoked_at: new Date() }).where('id', '=', row.sessionId).execute();
        return null;
      }
      if (idleFor > SESSION_TOUCH_MS) {
        await tx.updateTable('sessions').set({ last_seen_at: new Date() }).where('id', '=', row.sessionId).execute();
      }
      return {
        sessionId: row.sessionId,
        user: { id: row.id, email: row.email, name: row.name, isPlatformAdmin: row.is_platform_admin },
      };
    });
  }

  async logout(session: ResolvedSession, meta: RequestMeta): Promise<void> {
    await withAppRole(this.db, async (tx) => {
      await tx.updateTable('sessions').set({ revoked_at: new Date() }).where('id', '=', session.sessionId).execute();
      await this.audit(tx, session.user.id, 'user.logout', meta);
    });
  }

  /** Always resolves the same way, so it can't be used to discover accounts. */
  async forgotPassword(address: string, meta: RequestMeta): Promise<void> {
    const token = newToken();
    const user = await withAppRole(this.db, async (tx) => {
      const found = await tx
        .selectFrom('users')
        .select(['id', 'email'])
        .where('email', '=', address)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (found) {
        await this.issueToken(tx, found.id, 'reset_password', token, RESET_TTL_MS);
        await this.audit(tx, found.id, 'user.password_reset_requested', meta);
      }
      return found;
    });
    if (user) {
      await this.deliver({
        kind: 'password-reset',
        to: user.email,
        subject: 'Reset your WatchersNex password',
        text: 'Use the link below within 30 minutes to choose a new password. If you didn\'t ask for this, ignore this email; your password stays the same.',
        link: `${this.config.APP_BASE_URL}/reset-password?token=${token}`,
      });
    }
  }

  /** Sets a new password, clears any lockout and signs out every existing session. */
  async resetPassword(input: z.infer<typeof resetSchema>, meta: RequestMeta): Promise<void> {
    const passwordHash = await hashPassword(input.password);
    await withAppRole(this.db, async (tx) => {
      const userId = await this.consumeToken(tx, 'reset_password', input.token);
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, password_changed_at: new Date(), failed_login_count: 0, locked_until: null })
        .where('id', '=', userId)
        .execute();
      await tx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit(tx, userId, 'user.password_reset', meta);
    });
  }

  async updateProfile(session: ResolvedSession, input: z.infer<typeof profileSchema>, meta: RequestMeta): Promise<SessionUser> {
    await withAppRole(this.db, async (tx) => {
      await tx.updateTable('users').set({ name: input.name }).where('id', '=', session.user.id).execute();
      await this.audit(tx, session.user.id, 'user.profile_update', meta);
    });
    return { ...session.user, name: input.name };
  }

  /** Requires the current password; signs out every other session of this user. */
  async changePassword(session: ResolvedSession, input: z.infer<typeof changePasswordSchema>, meta: RequestMeta): Promise<void> {
    const user = await withAppRole(this.db, (tx) =>
      tx.selectFrom('users').select(['password_hash']).where('id', '=', session.user.id).executeTakeFirstOrThrow(),
    );
    if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
      throw new ProblemException(422, 'validation', 'Invalid request', 'Your current password is incorrect.', [
        { field: 'currentPassword', message: 'is incorrect' },
      ]);
    }
    if (input.newPassword.toLowerCase() === session.user.email) {
      throw new ProblemException(422, 'validation', 'Invalid request', 'Choose a password that is not your email address.', [
        { field: 'newPassword', message: 'must not be your email address' },
      ]);
    }
    const passwordHash = await hashPassword(input.newPassword);
    await withAppRole(this.db, async (tx) => {
      await tx.updateTable('users').set({ password_hash: passwordHash, password_changed_at: new Date() }).where('id', '=', session.user.id).execute();
      await tx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', session.user.id)
        .where('id', '<>', session.sessionId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit(tx, session.user.id, 'user.password_change', meta);
    });
  }

  private async recordFailedLogin(userId: string, meta: RequestMeta): Promise<boolean> {
    return withAppRole(this.db, async (tx) => {
      const row = await tx
        .updateTable('users')
        .set((eb) => ({ failed_login_count: eb('failed_login_count', '+', 1) }))
        .where('id', '=', userId)
        .returning('failed_login_count')
        .executeTakeFirstOrThrow();
      if (row.failed_login_count >= this.config.LOGIN_LOCKOUT_THRESHOLD) {
        await tx
          .updateTable('users')
          .set({ failed_login_count: 0, locked_until: new Date(Date.now() + LOCK_MS) })
          .where('id', '=', userId)
          .execute();
        await this.audit(tx, userId, 'user.locked', meta);
        return true;
      }
      await this.audit(tx, userId, 'user.login_failed', meta);
      return false;
    });
  }

  private async issueToken(
    tx: Tx,
    userId: string,
    purpose: 'verify_email' | 'reset_password',
    token: string,
    ttlMs: number,
  ): Promise<void> {
    // Only the newest link of each kind works.
    await tx
      .updateTable('verification_tokens')
      .set({ used_at: new Date() })
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .execute();
    await tx
      .insertInto('verification_tokens')
      .values({ id: randomUUID(), user_id: userId, purpose, token_hash: hashToken(token), expires_at: new Date(Date.now() + ttlMs) })
      .execute();
  }

  /** Marks a token used and returns its user, atomically, so a token works exactly once. */
  private async consumeToken(tx: Tx, purpose: 'verify_email' | 'reset_password', token: string): Promise<string> {
    const row = await tx
      .updateTable('verification_tokens')
      .set({ used_at: new Date() })
      .where('token_hash', '=', hashToken(token))
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning('user_id')
      .executeTakeFirst();
    if (!row) throw invalidToken();
    return row.user_id;
  }

  private async sendVerification(to: string, token: string): Promise<void> {
    await this.deliver({
      kind: 'verify-email',
      to,
      subject: 'Verify your email for WatchersNex',
      text: 'Confirm your email address within 24 hours to finish setting up your account.',
      link: `${this.config.APP_BASE_URL}/verify-email?token=${token}`,
    });
  }

  /**
   * Email failures are logged, not surfaced: the caller's response must not
   * differ by account existence, and users can request a new link.
   */
  private async deliver(message: EmailMessage): Promise<void> {
    try {
      await this.email.send(message);
    } catch (error) {
      this.logger.error({ err: error, kind: message.kind }, 'email delivery failed');
    }
  }

  private async audit(tx: Tx, userId: string, action: string, meta: RequestMeta): Promise<void> {
    await sql`SELECT wnx_record_account_audit(${randomUUID()}::uuid, ${userId}::uuid, ${action}, ${meta.ip}::inet, ${JSON.stringify({ userAgent: meta.userAgent?.slice(0, 200) ?? null })}::jsonb)`.execute(tx);
  }
}
