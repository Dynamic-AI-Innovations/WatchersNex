import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, isUuid, Tx, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import type { RequestMeta } from '../identity/auth.service.js';

const SEVERITY_RANK = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 } as const;
type Severity = keyof typeof SEVERITY_RANK;

const email = z.string().trim().toLowerCase().email('must be a valid email address').max(254);

export const alertPolicySchema = z.object({
  name: z.string().trim().min(1).max(120),
  minSeverity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).default('sev4'),
  notifyOn: z.array(z.enum(['opened', 'resolved'])).min(1, 'choose at least one event').max(2).default(['opened', 'resolved']),
  memberIds: z.array(z.string().uuid()).max(100).default([]),
  externalEmails: z.array(email).max(20).default([]),
  enabled: z.boolean().default(true),
}).refine((p) => p.memberIds.length + p.externalEmails.length > 0, { message: 'add at least one recipient', path: ['memberIds'] });

type PolicyInput = z.infer<typeof alertPolicySchema>;

function notFound(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Alert rule not found.');
}

/**
 * Who gets an incident email. Enabled policies whose severity threshold the
 * incident meets and whose events include this one contribute recipients;
 * member recipients must still belong to the organisation and be active.
 * With no enabled policy at all, owners and admins are alerted (the default).
 */
export async function resolveRecipients(tx: Tx, severity: Severity, event: 'opened' | 'resolved'): Promise<string[]> {
  const policies = await tx.selectFrom('alert_policies').selectAll().where('enabled', '=', true).execute();
  if (policies.length === 0) {
    const rows = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.role', 'in', ['owner', 'admin'])
      .where('u.status', '=', 'active')
      .execute();
    return rows.map((r) => r.email);
  }
  const matching = policies.filter(
    (p) => SEVERITY_RANK[severity] <= SEVERITY_RANK[p.min_severity as Severity] && p.notify_on.includes(event),
  );
  const memberIds = [...new Set(matching.flatMap((p) => p.member_ids))];
  const addresses = new Set(matching.flatMap((p) => p.external_emails.map((e) => e.toLowerCase())));
  if (memberIds.length) {
    const members = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.user_id', 'in', memberIds)
      .where('u.status', '=', 'active')
      .execute();
    for (const m of members) addresses.add(m.email.toLowerCase());
  }
  return [...addresses];
}

@Injectable()
export class AlertPoliciesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(orgId: string) {
    return withTenant(this.db, orgId, async (tx) => {
      const rows = await tx.selectFrom('alert_policies').selectAll().orderBy('name').execute();
      return rows.map(shape);
    });
  }

  async create(orgId: string, userId: string, input: PolicyInput, meta: RequestMeta) {
    return withTenant(this.db, orgId, async (tx) => {
      await this.assertMembers(tx, input.memberIds);
      const id = randomUUID();
      const row = await tx
        .insertInto('alert_policies')
        .values({
          id, organisation_id: orgId, name: input.name, min_severity: input.minSeverity, notify_on: input.notifyOn,
          member_ids: input.memberIds, external_emails: input.externalEmails, enabled: input.enabled, created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, orgId, userId, 'alert_policy.create', id, meta, { name: input.name });
      return shape(row);
    });
  }

  async update(orgId: string, userId: string, policyId: string, input: PolicyInput, meta: RequestMeta) {
    if (!isUuid(policyId)) throw notFound();
    return withTenant(this.db, orgId, async (tx) => {
      await this.assertMembers(tx, input.memberIds);
      const row = await tx
        .updateTable('alert_policies')
        .set({
          name: input.name, min_severity: input.minSeverity, notify_on: input.notifyOn, member_ids: input.memberIds,
          external_emails: input.externalEmails, enabled: input.enabled, updated_at: new Date(),
        })
        .where('id', '=', policyId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw notFound();
      await audit(tx, orgId, userId, 'alert_policy.update', policyId, meta, { name: input.name, enabled: input.enabled });
      return shape(row);
    });
  }

  async remove(orgId: string, userId: string, policyId: string, meta: RequestMeta) {
    if (!isUuid(policyId)) throw notFound();
    await withTenant(this.db, orgId, async (tx) => {
      const deleted = await tx.deleteFrom('alert_policies').where('id', '=', policyId).executeTakeFirst();
      if (!deleted.numDeletedRows) throw notFound();
      await audit(tx, orgId, userId, 'alert_policy.delete', policyId, meta, {});
    });
  }

  /** Member recipients must belong to this organisation (RLS scopes the lookup). */
  private async assertMembers(tx: Tx, memberIds: string[]) {
    if (!memberIds.length) return;
    const found = await tx.selectFrom('memberships').select('user_id').where('user_id', 'in', memberIds).execute();
    if (found.length !== new Set(memberIds).size) {
      throw new ProblemException(422, 'validation', 'Invalid request', 'One or more recipients are not members of this organisation.', [
        { field: 'memberIds', message: 'includes someone outside this organisation' },
      ]);
    }
  }
}

function shape(r: { id: string; name: string; min_severity: string; notify_on: string[]; member_ids: string[]; external_emails: string[]; enabled: boolean; updated_at: Date }) {
  return {
    id: r.id, name: r.name, minSeverity: r.min_severity, notifyOn: r.notify_on, memberIds: r.member_ids,
    externalEmails: r.external_emails, enabled: r.enabled, updatedAt: r.updated_at,
  };
}

async function audit(tx: Tx, orgId: string, userId: string, action: string, id: string, meta: RequestMeta, metadata: unknown) {
  await tx
    .insertInto('audit_events')
    .values({ id: randomUUID(), organisation_id: orgId, actor_id: userId, actor_type: 'user', action, resource_type: 'alert_policy', resource_id: id, ip: meta.ip, metadata: JSON.stringify(metadata) })
    .execute();
}
