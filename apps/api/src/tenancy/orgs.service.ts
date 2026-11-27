import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, isUniqueViolation, isUuid, withAppRole, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import type { RequestMeta } from '../identity/auth.service.js';

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, 'use 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen')
    .optional(),
});

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

function notFound(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Organisation not found.');
}

/** "Acme Ltd." -> "acme-ltd"; falls back to a random suffix if nothing usable is left. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : `org-${randomUUID().slice(0, 8)}`;
}

@Injectable()
export class OrgsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The user's own memberships, via the one audited cross-tenant function. */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const rows = await withAppRole(this.db, (tx) =>
      sql<{ organisation_id: string; role: Role; name: string; slug: string }>`
        SELECT organisation_id, role, name, slug FROM wnx_memberships_for_user(${userId}::uuid)`.execute(tx),
    );
    return rows.rows.map((r) => ({ id: r.organisation_id, name: r.name, slug: r.slug, role: r.role }));
  }

  /** The caller's role in an organisation; 404 when not a member, so existence isn't revealed. */
  async requireMembership(userId: string, orgId: string): Promise<OrgSummary> {
    if (!isUuid(orgId)) throw notFound();
    const membership = (await this.listForUser(userId)).find((m) => m.id === orgId);
    if (!membership) throw notFound();
    return membership;
  }

  /**
   * Membership with one of the allowed roles. Non-members get 404 (existence
   * isn't revealed); members without the role get 403 with a clear reason.
   */
  async requireRole(userId: string, orgId: string, allowed: Role[]): Promise<OrgSummary> {
    const membership = await this.requireMembership(userId, orgId);
    if (!allowed.includes(membership.role)) {
      throw new ProblemException(403, 'forbidden', 'Not allowed', `Your role (${membership.role}) can't do this. Ask an organisation admin.`);
    }
    return membership;
  }

  async create(userId: string, input: z.infer<typeof createOrgSchema>, meta: RequestMeta) {
    const id = randomUUID();
    const slug = input.slug ?? slugify(input.name);
    try {
      return await withTenant(this.db, id, async (tx) => {
        const org = await tx
          .insertInto('organisations')
          .values({ id, name: input.name, slug, plan_id: 'pilot' })
          .returning(['id', 'name', 'slug', 'timezone', 'plan_id', 'created_at'])
          .executeTakeFirstOrThrow();
        await tx.insertInto('memberships').values({ organisation_id: id, user_id: userId, role: 'owner' }).execute();
        await tx
          .insertInto('audit_events')
          .values({
            id: randomUUID(),
            organisation_id: id,
            actor_id: userId,
            actor_type: 'user',
            action: 'organisation.create',
            resource_type: 'organisation',
            resource_id: id,
            ip: meta.ip,
            metadata: JSON.stringify({ name: input.name, slug }),
          })
          .execute();
        return { ...org, role: 'owner' as const };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemException(409, 'slug-taken', 'Address already in use', 'That organisation address is taken. Choose another.', [
          { field: 'slug', message: 'is already in use' },
        ]);
      }
      throw error;
    }
  }

  async get(userId: string, orgId: string) {
    const membership = await this.requireMembership(userId, orgId);
    const org = await withTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('organisations')
        .select(['id', 'name', 'slug', 'timezone', 'plan_id', 'created_at'])
        .where('id', '=', orgId)
        .executeTakeFirst(),
    );
    if (!org) throw notFound();
    return { ...org, role: membership.role };
  }
}
