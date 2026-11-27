import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, isUuid, Tx, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';
import type { RequestMeta } from '../identity/auth.service.js';
import { MONITOR_POLICY } from './policy.js';
import { parseTargetUrl, resolveTarget, TargetPolicy, TargetRejected } from './ssrf.js';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const httpConfig = z
  .object({
    method: z.enum(['GET', 'HEAD']).default('GET'),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    followRedirects: z.boolean().default(true),
    expectedStatus: z
      .object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
      .refine((r) => r.min <= r.max, 'min must not exceed max')
      .default({ min: 200, max: 399 }),
    keyword: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const sslConfig = z.object({ warnDays: z.number().int().min(1).max(90).default(14) }).strict();
const dnsConfig = z
  .object({
    recordType: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT']).default('A'),
    expectedValue: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const common = {
  name: z.string().trim().min(1).max(120),
  intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(600)]),
  criticality: z.enum(['critical', 'standard', 'low']).default('standard'),
};
const attested = z.literal(true, { error: "Confirm you're authorised to monitor this address." });
const hostname = z.string().trim().toLowerCase().regex(HOSTNAME, 'enter a host name such as example.com, without https://');

export const createMonitorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), target: z.string().trim().max(2048), config: httpConfig.default({} as never), authorisationAttested: attested, ...common }),
  z.object({ type: z.literal('api'), target: z.string().trim().max(2048), config: httpConfig.default({} as never), authorisationAttested: attested, ...common }),
  z.object({ type: z.literal('ssl'), target: hostname, config: sslConfig.default({} as never), authorisationAttested: attested, ...common }),
  z.object({ type: z.literal('dns'), target: hostname, config: dnsConfig.default({} as never), authorisationAttested: attested, ...common }),
]);

export const updateMonitorSchema = z
  .object({
    name: common.name.optional(),
    intervalSeconds: common.intervalSeconds.optional(),
    criticality: z.enum(['critical', 'standard', 'low']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type CreateMonitor = z.infer<typeof createMonitorSchema>;

function notFound(): ProblemException {
  return new ProblemException(404, 'not-found', 'Not found', 'Monitor not found.');
}

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MONITOR_POLICY) private readonly policy: TargetPolicy,
  ) {}

  /** Rejects private or invalid targets at save time, so users get immediate feedback. */
  private async assertTargetAllowed(type: CreateMonitor['type'], target: string): Promise<void> {
    try {
      if (type === 'http' || type === 'api') {
        const url = parseTargetUrl(target);
        await resolveTarget(url.hostname, this.policy);
      } else if (type === 'ssl') {
        await resolveTarget(target, this.policy);
      }
    } catch (error) {
      if (error instanceof TargetRejected) {
        throw new ProblemException(422, 'target-rejected', 'Address not allowed', error.message, [{ field: 'target', message: error.message }]);
      }
      throw error;
    }
  }

  private async planLimits(tx: Tx, orgId: string): Promise<{ monitors: number; min_interval_seconds: number }> {
    const row = await sql<{ limits: { monitors: number; min_interval_seconds: number } }>`
      SELECT p.limits FROM organisations o JOIN plans p ON p.id = o.plan_id WHERE o.id = ${orgId}`.execute(tx);
    return row.rows[0]?.limits ?? { monitors: 0, min_interval_seconds: 600 };
  }

  async create(orgId: string, userId: string, input: CreateMonitor, meta: RequestMeta) {
    await this.assertTargetAllowed(input.type, input.target);
    const id = randomUUID();
    return withTenant(this.db, orgId, async (tx) => {
      const limits = await this.planLimits(tx, orgId);
      if (input.intervalSeconds < limits.min_interval_seconds) {
        throw new ProblemException(422, 'plan-limit', 'Not available on your plan', `Your plan's shortest check interval is ${limits.min_interval_seconds / 60} minutes.`, [
          { field: 'intervalSeconds', message: 'is shorter than your plan allows' },
        ]);
      }
      const { count } = await tx
        .selectFrom('monitors')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(count) >= limits.monitors) {
        throw new ProblemException(422, 'plan-limit', 'Monitor limit reached', `Your plan includes ${limits.monitors} monitors. Delete one or upgrade your plan.`);
      }
      await tx
        .insertInto('monitors')
        .values({
          id, organisation_id: orgId, name: input.name, type: input.type, target: input.target,
          config: JSON.stringify(input.config), interval_seconds: input.intervalSeconds, criticality: input.criticality,
          created_by: userId, authorisation_attested_at: new Date(),
        })
        .execute();
      await tx.insertInto('monitor_states').values({ monitor_id: id, organisation_id: orgId }).execute();
      await this.audit(tx, orgId, userId, 'monitor.create', id, meta, { name: input.name, type: input.type, target: input.target });
      return this.getOne(tx, id);
    });
  }

  async list(orgId: string) {
    return withTenant(this.db, orgId, async (tx) => {
      const rows = await this.baseQuery(tx).where('m.deleted_at', 'is', null).orderBy('m.name').execute();
      const uptime = await this.uptime24h(tx);
      return rows.map((r) => ({ ...this.shape(r), checksPassed24h: uptime.get(r.id) ?? null }));
    });
  }

  async get(orgId: string, monitorId: string) {
    if (!isUuid(monitorId)) throw notFound();
    return withTenant(this.db, orgId, async (tx) => {
      const monitor = await this.getOne(tx, monitorId);
      const series = await sql<{ checked_at: Date; outcome: 'up' | 'down'; latency_ms: number | null; failure_class: string | null; status_code: number | null; message: string | null }>`
        SELECT DISTINCT ON (scheduled_at) checked_at, outcome, latency_ms, failure_class, status_code, detail->>'message' AS message
        FROM check_results
        WHERE monitor_id = ${monitorId} AND checked_at > now() - interval '24 hours'
        ORDER BY scheduled_at DESC, attempt DESC
        LIMIT 1440`.execute(tx);
      const incidents = await tx
        .selectFrom('incidents')
        .select(['id', 'number', 'title', 'severity', 'status', 'started_at', 'resolved_at'])
        .where('monitor_id', '=', monitorId)
        .orderBy('started_at', 'desc')
        .limit(10)
        .execute();
      const checks = series.rows;
      const latencies = checks.filter((c) => c.outcome === 'up' && c.latency_ms !== null).map((c) => c.latency_ms!).sort((a, b) => a - b);
      const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]! : null);
      return {
        ...monitor,
        stats24h: {
          checks: checks.length,
          checksPassed: checks.length ? checks.filter((c) => c.outcome === 'up').length / checks.length : null,
          latencyP50Ms: pct(0.5),
          latencyP95Ms: pct(0.95),
        },
        recentChecks: checks.slice(0, 50),
        series: [...checks].reverse().map((c) => ({ at: c.checked_at, outcome: c.outcome, latencyMs: c.latency_ms })),
        incidents,
      };
    });
  }

  async update(orgId: string, userId: string, monitorId: string, input: z.infer<typeof updateMonitorSchema>, meta: RequestMeta) {
    if (!isUuid(monitorId)) throw notFound();
    return withTenant(this.db, orgId, async (tx) => {
      const existing = await tx.selectFrom('monitors').select(['type', 'config']).where('id', '=', monitorId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!existing) throw notFound();
      let config: unknown;
      if (input.config) {
        const schema = existing.type === 'ssl' ? sslConfig : existing.type === 'dns' ? dnsConfig : httpConfig;
        const parsed = schema.safeParse({ ...(existing.config as object), ...input.config });
        if (!parsed.success) {
          throw new ProblemException(422, 'validation', 'Invalid request', 'One or more fields are invalid.', parsed.error.issues.map((i) => ({ field: `config.${i.path.join('.')}`, message: i.message })));
        }
        config = parsed.data;
      }
      if (input.intervalSeconds) {
        const limits = await this.planLimits(tx, orgId);
        if (input.intervalSeconds < limits.min_interval_seconds) {
          throw new ProblemException(422, 'plan-limit', 'Not available on your plan', `Your plan's shortest check interval is ${limits.min_interval_seconds / 60} minutes.`);
        }
      }
      await tx
        .updateTable('monitors')
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.intervalSeconds ? { interval_seconds: input.intervalSeconds } : {}),
          ...(input.criticality ? { criticality: input.criticality } : {}),
          ...(config ? { config: JSON.stringify(config) } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', monitorId)
        .execute();
      await this.audit(tx, orgId, userId, 'monitor.update', monitorId, meta, input);
      return this.getOne(tx, monitorId);
    });
  }

  async setEnabled(orgId: string, userId: string, monitorId: string, enabled: boolean, meta: RequestMeta) {
    if (!isUuid(monitorId)) throw notFound();
    return withTenant(this.db, orgId, async (tx) => {
      const updated = await tx
        .updateTable('monitors')
        .set({ enabled, updated_at: new Date(), ...(enabled ? { next_check_at: new Date() } : {}) })
        .where('id', '=', monitorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!updated.numUpdatedRows) throw notFound();
      await tx
        .updateTable('monitor_states')
        .set(enabled ? { state: 'pending', consecutive_failures: 0, consecutive_successes: 0, first_failure_at: null } : { state: 'paused' })
        .where('monitor_id', '=', monitorId)
        .execute();
      await this.audit(tx, orgId, userId, enabled ? 'monitor.resume' : 'monitor.pause', monitorId, meta, {});
      return this.getOne(tx, monitorId);
    });
  }

  /** Soft delete: the monitor stops and disappears; its history stays for reports. */
  async remove(orgId: string, userId: string, monitorId: string, meta: RequestMeta) {
    if (!isUuid(monitorId)) throw notFound();
    await withTenant(this.db, orgId, async (tx) => {
      const updated = await tx
        .updateTable('monitors')
        .set({ deleted_at: new Date(), enabled: false })
        .where('id', '=', monitorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!updated.numUpdatedRows) throw notFound();
      await this.audit(tx, orgId, userId, 'monitor.delete', monitorId, meta, {});
    });
  }

  async overview(orgId: string) {
    return withTenant(this.db, orgId, async (tx) => {
      const states = await tx
        .selectFrom('monitors as m')
        .leftJoin('monitor_states as s', 's.monitor_id', 'm.id')
        .select(['s.state', (eb) => eb.fn.countAll<string>().as('count')])
        .where('m.deleted_at', 'is', null)
        .groupBy('s.state')
        .execute();
      const byState: Record<string, number> = {};
      for (const row of states) byState[row.state ?? 'pending'] = Number(row.count);
      const openIncidents = await tx
        .selectFrom('incidents as i')
        .innerJoin('monitors as m', 'm.id', 'i.monitor_id')
        .select(['i.id', 'i.number', 'i.title', 'i.severity', 'i.status', 'i.started_at', 'm.name as monitorName'])
        .where('i.status', '<>', 'resolved')
        .orderBy('i.started_at', 'desc')
        .limit(10)
        .execute();
      const attention = await this.baseQuery(tx)
        .where('m.deleted_at', 'is', null)
        .where('s.state', 'in', ['down', 'suspected', 'recovering'])
        .orderBy('m.name')
        .limit(10)
        .execute();
      const total = Object.values(byState).reduce((a, b) => a + b, 0);
      return {
        monitors: {
          total,
          up: byState.up ?? 0,
          down: (byState.down ?? 0) + (byState.recovering ?? 0),
          degraded: byState.suspected ?? 0,
          pending: byState.pending ?? 0,
          paused: byState.paused ?? 0,
        },
        openIncidents,
        needsAttention: attention.map((r) => this.shape(r)),
      };
    });
  }

  private baseQuery(tx: Tx) {
    return tx
      .selectFrom('monitors as m')
      .leftJoin('monitor_states as s', 's.monitor_id', 'm.id')
      .select([
        'm.id', 'm.name', 'm.type', 'm.target', 'm.config', 'm.interval_seconds', 'm.criticality', 'm.enabled', 'm.created_at',
        's.state', 's.last_checked_at', 's.last_outcome', 's.last_status_code', 's.last_latency_ms', 's.last_failure_class', 's.last_detail', 's.open_incident_id',
      ]);
  }

  private async getOne(tx: Tx, monitorId: string) {
    const row = await this.baseQuery(tx).where('m.id', '=', monitorId).where('m.deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw notFound();
    return this.shape(row);
  }

  private shape(r: Awaited<ReturnType<ReturnType<MonitorsService['baseQuery']>['executeTakeFirstOrThrow']>>) {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      target: r.target,
      config: r.config,
      intervalSeconds: r.interval_seconds,
      criticality: r.criticality,
      enabled: r.enabled,
      createdAt: r.created_at,
      status: r.state ?? 'pending',
      lastCheckedAt: r.last_checked_at,
      lastOutcome: r.last_outcome,
      lastStatusCode: r.last_status_code,
      lastLatencyMs: r.last_latency_ms,
      lastFailureClass: r.last_failure_class,
      lastMessage: r.last_detail,
      openIncidentId: r.open_incident_id,
    };
  }

  private async uptime24h(tx: Tx): Promise<Map<string, number>> {
    const rows = await sql<{ monitor_id: string; ratio: number }>`
      SELECT monitor_id, avg(CASE WHEN outcome = 'up' THEN 1.0 ELSE 0.0 END)::float AS ratio
      FROM (
        SELECT DISTINCT ON (monitor_id, scheduled_at) monitor_id, outcome
        FROM check_results
        WHERE checked_at > now() - interval '24 hours'
        ORDER BY monitor_id, scheduled_at, attempt DESC
      ) finals
      GROUP BY monitor_id`.execute(tx);
    return new Map(rows.rows.map((r) => [r.monitor_id, Number(r.ratio)]));
  }

  private async audit(tx: Tx, orgId: string, userId: string, action: string, monitorId: string, meta: RequestMeta, metadata: unknown) {
    await tx
      .insertInto('audit_events')
      .values({
        id: randomUUID(), organisation_id: orgId, actor_id: userId, actor_type: 'user', action,
        resource_type: 'monitor', resource_id: monitorId, ip: meta.ip, metadata: JSON.stringify(metadata),
      })
      .execute();
  }
}
