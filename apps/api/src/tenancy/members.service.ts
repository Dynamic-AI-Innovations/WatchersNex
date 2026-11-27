import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import { LOGGER } from '../common/logger.js';
import { ProblemException } from '../common/problem.filter.js';
import { hashToken, newToken } from '../common/tokens.js';
import { APP_CONFIG, AppConfig } from '../config/config.js';
import { Db, isUuid, Tx, withAppRole, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import { EMAIL_SENDER, EmailSender } from '../email/email.js';
import type { RequestMeta, SessionUser } from '../identity/auth.service.js';
import type { Role } from './orgs.service.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('must be a valid email address').max(254),
  role: z.enum(['admin', 'operator', 'viewer']),
});
export const changeRoleSchema = z.object({ role: z.enum(['owner', 'admin', 'operator', 'viewer']) });
export const acceptSchema = z.object({ token: z.string().min(20).max(100) });

function forbidden(detail: string): ProblemException {
  return new ProblemException(403, 'forbidden', 'Not allowed', detail);
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async list(orgId: string) {
    return withTenant(this.db, orgId, async (tx) => {
      const members = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.name', 'u.email', 'm.role', 'm.created_at as joinedAt'])
        .orderBy('u.name')
        .execute();
      const invitations = await tx
        .selectFrom('invitations as i')
        .innerJoin('users as u', 'u.id', 'i.invited_by')
        .select(['i.id', 'i.email', 'i.role', 'i.expires_at as expiresAt', 'u.name as invitedBy'])
        .where('i.accepted_at', 'is', null)
        .where('i.expires_at', '>', new Date())
        .orderBy('i.email')
        .execute();
      return { members, invitations };
    });
  }

  async invite(orgId: string, inviter: SessionUser, input: z.infer<typeof inviteSchema>, meta: RequestMeta) {
    const token = newToken();
    const orgName = await withTenant(this.db, orgId, async (tx) => {
      const existing = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.id')
        .where('u.email', '=', input.email)
        .executeTakeFirst();
      if (existing) {
        throw new ProblemException(409, 'already-member', 'Already a member', `${input.email} is already in this organisation.`);
      }
      // Re-inviting replaces any pending invitation: only the newest link works.
      await tx.deleteFrom('invitations').where('email', '=', input.email).where('accepted_at', 'is', null).execute();
      const id = randomUUID();
      await tx
        .insertInto('invitations')
        .values({ id, organisation_id: orgId, email: input.email, role: input.role, token_hash: hashToken(token), invited_by: inviter.id, expires_at: new Date(Date.now() + INVITE_TTL_MS) })
        .execute();
      await this.audit(tx, orgId, inviter.id, 'member.invite', id, meta, { email: input.email, role: input.role });
      const org = await tx.selectFrom('organisations').select('name').where('id', '=', orgId).executeTakeFirstOrThrow();
      return org.name;
    });

    try {
      await this.email.send({
        kind: 'invitation',
        to: input.email,
        subject: `${inviter.name} invited you to ${orgName} on WatchersNex`,
        text: `${inviter.name} invited you to join ${orgName} on WatchersNex as ${input.role === 'admin' ? 'an admin' : `an ${input.role}`}. The link works for 7 days. If you don't have an account yet, create one with this email address first.`,
        link: `${this.config.APP_BASE_URL}/invite?token=${token}`,
      });
    } catch (error) {
      this.logger.error({ err: error }, 'invitation email failed');
    }
    return this.list(orgId);
  }

  async revokeInvitation(orgId: string, actorId: string, invitationId: string, meta: RequestMeta) {
    if (!isUuid(invitationId)) throw notFoundInvite();
    await withTenant(this.db, orgId, async (tx) => {
      const deleted = await tx.deleteFrom('invitations').where('id', '=', invitationId).where('accepted_at', 'is', null).executeTakeFirst();
      if (!deleted.numDeletedRows) throw notFoundInvite();
      await this.audit(tx, orgId, actorId, 'member.invite_revoke', invitationId, meta, {});
    });
  }

  async changeRole(orgId: string, actor: { id: string; role: Role }, userId: string, role: Role, meta: RequestMeta) {
    if (!isUuid(userId)) throw notFoundMember();
    await withTenant(this.db, orgId, async (tx) => {
      const target = await this.lockMember(tx, userId);
      if (actor.role !== 'owner' && (target.role === 'owner' || role === 'owner')) {
        throw forbidden('Only an owner can grant or remove ownership.');
      }
      if (target.role === 'owner' && role !== 'owner') await this.assertNotLastOwner(tx);
      await tx.updateTable('memberships').set({ role }).where('user_id', '=', userId).execute();
      await this.audit(tx, orgId, actor.id, 'member.role_change', userId, meta, { from: target.role, to: role });
    });
    return this.list(orgId);
  }

  /** Removes a member, or lets a member leave. The last owner can do neither. */
  async remove(orgId: string, actor: { id: string; role: Role }, userId: string, meta: RequestMeta) {
    if (!isUuid(userId)) throw notFoundMember();
    const leaving = actor.id === userId;
    await withTenant(this.db, orgId, async (tx) => {
      const target = await this.lockMember(tx, userId);
      if (!leaving) {
        if (actor.role !== 'owner' && actor.role !== 'admin') throw forbidden("Your role can't remove members.");
        if (actor.role !== 'owner' && target.role === 'owner') throw forbidden('Only an owner can remove another owner.');
      }
      if (target.role === 'owner') await this.assertNotLastOwner(tx);
      await tx.deleteFrom('memberships').where('user_id', '=', userId).execute();
      await this.audit(tx, orgId, actor.id, leaving ? 'member.leave' : 'member.remove', userId, meta, { role: target.role });
    });
  }

  /** What an invitation is for, shown before the invitee accepts. Public: the token is the secret. */
  async preview(token: string) {
    const row = await withAppRole(this.db, (tx) =>
      sql<{ organisation_name: string; role: string; email: string; expires_at: Date }>`
        SELECT * FROM wnx_invitation_preview(${hashToken(token)})`.execute(tx),
    );
    const invite = row.rows[0];
    if (!invite) throw invalidInvite();
    return { organisationName: invite.organisation_name, role: invite.role, email: invite.email, expiresAt: invite.expires_at };
  }

  async accept(user: SessionUser, token: string) {
    const result = await withAppRole(this.db, (tx) =>
      sql<{ org: string | null }>`SELECT wnx_accept_invitation(${hashToken(token)}, ${user.id}::uuid, ${user.email}::citext) AS org`.execute(tx),
    );
    const orgId = result.rows[0]?.org;
    if (!orgId) throw invalidInvite();
    return { organisationId: orgId };
  }

  private async lockMember(tx: Tx, userId: string) {
    const target = await tx.selectFrom('memberships').select('role').where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!target) throw notFoundMember();
    return target;
  }

  private async assertNotLastOwner(tx: Tx) {
    const owners = await tx
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    if (Number(owners.n) <= 1) {
      throw new ProblemException(409, 'last-owner', 'An owner is required', 'Every organisation needs at least one owner. Make someone else an owner first.');
    }
  }

  private async audit(tx: Tx, orgId: string, actorId: string, action: string, resourceId: string, meta: RequestMeta, metadata: unknown) {
    await tx
      .insertInto('audit_events')
      .values({ id: randomUUID(), organisation_id: orgId, actor_id: actorId, actor_type: 'user', action, resource_type: 'membership', resource_id: resourceId, ip: meta.ip, metadata: JSON.stringify(metadata) })
      .execute();
  }
}

function notFoundMember(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Member not found.');
}
function notFoundInvite(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Invitation not found.');
}
function invalidInvite(): ProblemException {
  return new ProblemException(400, 'invalid-invitation', 'Invitation not valid', 'This invitation is invalid, has expired, or was sent to a different email address than the one you are signed in with.');
}
