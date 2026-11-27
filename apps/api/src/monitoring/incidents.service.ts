import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, isUuid, Tx, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import type { RequestMeta } from '../identity/auth.service.js';

export const noteSchema = z.object({ text: z.string().trim().min(1).max(2000) });
export const listIncidentsSchema = z.object({ status: z.enum(['open', 'resolved', 'all']).default('all') });

function notFound(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Incident not found.');
}

@Injectable()
export class IncidentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(orgId: string, status: 'open' | 'resolved' | 'all') {
    return withTenant(this.db, orgId, async (tx) => {
      let query = tx
        .selectFrom('incidents as i')
        .innerJoin('monitors as m', 'm.id', 'i.monitor_id')
        .leftJoin('users as u', 'u.id', 'i.acknowledged_by')
        .select([
          'i.id', 'i.number', 'i.title', 'i.severity', 'i.status', 'i.started_at', 'i.detected_at',
          'i.acknowledged_at', 'i.resolved_at', 'm.id as monitorId', 'm.name as monitorName', 'u.name as acknowledgedByName',
        ])
        .orderBy('i.started_at', 'desc')
        .limit(200);
      if (status === 'open') query = query.where('i.status', '<>', 'resolved');
      if (status === 'resolved') query = query.where('i.status', '=', 'resolved');
      return query.execute();
    });
  }

  async get(orgId: string, incidentId: string) {
    if (!isUuid(incidentId)) throw notFound();
    return withTenant(this.db, orgId, async (tx) => {
      const incident = await tx
        .selectFrom('incidents as i')
        .innerJoin('monitors as m', 'm.id', 'i.monitor_id')
        .selectAll('i')
        .select(['m.name as monitorName', 'm.target as monitorTarget', 'm.type as monitorType'])
        .where('i.id', '=', incidentId)
        .executeTakeFirst();
      if (!incident) throw notFound();
      const timeline = await tx
        .selectFrom('incident_events as e')
        .leftJoin('users as u', 'u.id', 'e.actor_id')
        .select(['e.id', 'e.type', 'e.occurred_at', 'e.details', 'u.name as actorName'])
        .where('e.incident_id', '=', incidentId)
        .orderBy('e.occurred_at', 'asc')
        .execute();
      return { ...incident, durationSeconds: Math.round(((incident.resolved_at ?? new Date()).getTime() - incident.started_at.getTime()) / 1000), timeline };
    });
  }

  async acknowledge(orgId: string, userId: string, incidentId: string, meta: RequestMeta) {
    return this.transition(orgId, incidentId, async (tx) => {
      const updated = await tx
        .updateTable('incidents')
        .set({ status: 'acknowledged', acknowledged_at: new Date(), acknowledged_by: userId })
        .where('id', '=', incidentId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      if (!updated.numUpdatedRows) throw conflict('Only an open incident can be acknowledged.');
      await this.event(tx, orgId, incidentId, 'acknowledged', userId, {});
      await this.audit(tx, orgId, userId, 'incident.acknowledge', incidentId, meta);
    });
  }

  /**
   * Manual resolve. If the service is in fact still failing, the monitor starts
   * confirmation afresh and a new incident opens; the timeline keeps both.
   */
  async resolve(orgId: string, userId: string, incidentId: string, meta: RequestMeta) {
    return this.transition(orgId, incidentId, async (tx) => {
      const updated = await tx
        .updateTable('incidents')
        .set({ status: 'resolved', resolved_at: new Date(), resolved_by: userId })
        .where('id', '=', incidentId)
        .where('status', '<>', 'resolved')
        .returning('monitor_id')
        .executeTakeFirst();
      if (!updated) throw conflict('This incident is already resolved.');
      await tx
        .updateTable('monitor_states')
        .set({ state: 'pending', consecutive_failures: 0, consecutive_successes: 0, first_failure_at: null, open_incident_id: null })
        .where('monitor_id', '=', updated.monitor_id)
        .where('open_incident_id', '=', incidentId)
        .execute();
      await this.event(tx, orgId, incidentId, 'resolved', userId, { automatic: false });
      await this.audit(tx, orgId, userId, 'incident.resolve', incidentId, meta);
    });
  }

  async addNote(orgId: string, userId: string, incidentId: string, text: string, meta: RequestMeta) {
    return this.transition(orgId, incidentId, async (tx) => {
      await this.event(tx, orgId, incidentId, 'note', userId, { text });
      await this.audit(tx, orgId, userId, 'incident.note', incidentId, meta);
    });
  }

  private async transition(orgId: string, incidentId: string, work: (tx: Tx) => Promise<void>) {
    if (!isUuid(incidentId)) throw notFound();
    await withTenant(this.db, orgId, async (tx) => {
      const exists = await tx.selectFrom('incidents').select('id').where('id', '=', incidentId).executeTakeFirst();
      if (!exists) throw notFound();
      await work(tx);
    });
    return this.get(orgId, incidentId);
  }

  private async event(tx: Tx, orgId: string, incidentId: string, type: 'acknowledged' | 'resolved' | 'note', actorId: string, details: unknown) {
    await tx
      .insertInto('incident_events')
      .values({ id: randomUUID(), organisation_id: orgId, incident_id: incidentId, type, actor_id: actorId, details: JSON.stringify(details) })
      .execute();
  }

  private async audit(tx: Tx, orgId: string, userId: string, action: string, incidentId: string, meta: RequestMeta) {
    await tx
      .insertInto('audit_events')
      .values({ id: randomUUID(), organisation_id: orgId, actor_id: userId, actor_type: 'user', action, resource_type: 'incident', resource_id: incidentId, ip: meta.ip, metadata: '{}' })
      .execute();
  }
}

function conflict(detail: string): ProblemException {
  return new ProblemException(409, 'conflict', 'Not possible right now', detail);
}
