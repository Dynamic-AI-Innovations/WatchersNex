import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, Tx, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import type { RequestMeta } from '../identity/auth.service.js';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));

export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'must be an IANA time zone such as Africa/Lagos').optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.timezone !== undefined, 'nothing to change');

export const auditQuerySchema = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Injectable()
export class WorkspaceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async update(orgId: string, userId: string, input: z.infer<typeof updateOrgSchema>, meta: RequestMeta) {
    return withTenant(this.db, orgId, async (tx) => {
      const org = await tx
        .updateTable('organisations')
        .set({ ...(input.name ? { name: input.name } : {}), ...(input.timezone ? { timezone: input.timezone } : {}) })
        .where('id', '=', orgId)
        .returning(['id', 'name', 'slug', 'timezone', 'plan_id', 'created_at'])
        .executeTakeFirstOrThrow();
      await this.audit(tx, orgId, userId, 'organisation.update', meta, input);
      return org;
    });
  }

  /** The plan's limits next to current use (FR-022). */
  async planAndUsage(orgId: string) {
    return withTenant(this.db, orgId, async (tx) => {
      const plan = await sql<{ id: string; name: string; limits: Record<string, number> }>`
        SELECT p.id, p.name, p.limits FROM organisations o JOIN plans p ON p.id = o.plan_id WHERE o.id = ${orgId}`.execute(tx);
      const usage = await sql<{ monitors: number; members: number; invitations: number; fastest: number | null }>`
        SELECT (SELECT count(*)::int FROM monitors WHERE deleted_at IS NULL) AS monitors,
               (SELECT count(*)::int FROM memberships) AS members,
               (SELECT count(*)::int FROM invitations WHERE accepted_at IS NULL AND expires_at > now()) AS invitations,
               (SELECT min(interval_seconds) FROM monitors WHERE deleted_at IS NULL) AS fastest`.execute(tx);
      const p = plan.rows[0];
      if (!p) throw new ProblemException(404, 'not-found', 'Not found', 'Plan not found.');
      return { plan: { id: p.id, name: p.name, limits: p.limits }, usage: usage.rows[0] };
    });
  }

  async auditLog(orgId: string, query: z.infer<typeof auditQuerySchema>) {
    return withTenant(this.db, orgId, async (tx) => {
      let q = tx
        .selectFrom('audit_events as a')
        .leftJoin('users as u', 'u.id', 'a.actor_id')
        .select(['a.id', 'a.action', 'a.resource_type as resourceType', 'a.resource_id as resourceId', 'a.occurred_at as occurredAt', 'a.ip', 'a.metadata', 'a.actor_type as actorType', 'u.name as actorName', 'u.email as actorEmail'])
        .orderBy('a.occurred_at', 'desc')
        .limit(query.limit + 1);
      if (query.before) q = q.where('a.occurred_at', '<', query.before);
      const rows = await q.execute();
      const items = rows.slice(0, query.limit);
      return { items, nextBefore: rows.length > query.limit ? items.at(-1)?.occurredAt : null };
    });
  }

  private async audit(tx: Tx, orgId: string, userId: string, action: string, meta: RequestMeta, metadata: unknown) {
    await tx
      .insertInto('audit_events')
      .values({ id: randomUUID(), organisation_id: orgId, actor_id: userId, actor_type: 'user', action, resource_type: 'organisation', resource_id: orgId, ip: meta.ip, metadata: JSON.stringify(metadata) })
      .execute();
  }
}
