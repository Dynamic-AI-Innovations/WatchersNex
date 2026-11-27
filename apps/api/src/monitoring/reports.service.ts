import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ProblemException } from '../common/problem.filter.js';
import { Db, withTenant } from '../db/database.js';
import { DB } from '../db/database.module.js';

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 92;

export const reportQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((q) => q.from < q.to, { message: 'must be before "to"', path: ['from'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_RANGE_DAYS * DAY, { message: `reports cover at most ${MAX_RANGE_DAYS} days`, path: ['to'] });

export interface ServiceAvailability {
  monitorId: string;
  name: string;
  type: string;
  target: string;
  deleted: boolean;
  periodSeconds: number;
  downtimeSeconds: number;
  availability: number | null;
  incidents: number;
  checks: number;
  checksPassed: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/**
 * Availability method (decision D-08), printed with every report:
 * availability = 1 − (confirmed incident time ÷ monitored time). Incident time
 * runs from the first failing check to recovery. Monitored time runs from the
 * later of the report start and the service's creation, to the earlier of the
 * report end, now, and its deletion.
 */
export const METHOD_NOTE =
  'Availability = 1 − (confirmed incident time ÷ monitored time). Incident time runs from the first failing check to recovery. ' +
  'Monitored time starts when the service was added if that is after the report start. Check statistics cover the last 30 days of raw results.';

@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async availability(orgId: string, from: Date, to: Date) {
    const end = new Date(Math.min(to.getTime(), Date.now()));
    if (end <= from) throw new ProblemException(422, 'validation', 'Invalid request', 'The report period must include some time in the past.');

    return withTenant(this.db, orgId, async (tx) => {
      const monitors = await tx
        .selectFrom('monitors')
        .select(['id', 'name', 'type', 'target', 'created_at', 'deleted_at'])
        .where('created_at', '<', end)
        .where((eb) => eb.or([eb('deleted_at', 'is', null), eb('deleted_at', '>', from)]))
        .orderBy('name')
        .execute();

      const incidents = await tx
        .selectFrom('incidents as i')
        .innerJoin('monitors as m', 'm.id', 'i.monitor_id')
        .select(['i.id', 'i.number', 'i.title', 'i.severity', 'i.status', 'i.monitor_id', 'i.started_at', 'i.resolved_at', 'm.name as monitorName'])
        .where('i.started_at', '<', end)
        .where((eb) => eb.or([eb('i.resolved_at', 'is', null), eb('i.resolved_at', '>', from)]))
        .orderBy('i.started_at', 'desc')
        .execute();

      const checkStats = await sql<{ monitor_id: string; checks: number; passed: number; p50: number | null; p95: number | null }>`
        SELECT monitor_id,
               count(*)::int AS checks,
               avg(CASE WHEN outcome = 'up' THEN 1.0 ELSE 0.0 END)::float AS passed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'up') AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'up') AS p95
        FROM (
          SELECT DISTINCT ON (monitor_id, scheduled_at) monitor_id, outcome, latency_ms
          FROM check_results
          WHERE checked_at >= ${from} AND checked_at < ${end}
          ORDER BY monitor_id, scheduled_at, attempt DESC
        ) finals
        GROUP BY monitor_id`.execute(tx);
      const stats = new Map(checkStats.rows.map((r) => [r.monitor_id, r]));

      const services: ServiceAvailability[] = monitors.map((m) => {
        const start = Math.max(from.getTime(), m.created_at.getTime());
        const stop = Math.min(end.getTime(), m.deleted_at?.getTime() ?? Infinity);
        const period = Math.max(0, stop - start);
        let down = 0;
        let count = 0;
        for (const i of incidents.filter((x) => x.monitor_id === m.id)) {
          const overlap = Math.min(stop, (i.resolved_at ?? new Date()).getTime()) - Math.max(start, i.started_at.getTime());
          if (overlap > 0) down += overlap;
          if (i.started_at.getTime() >= start && i.started_at.getTime() < stop) count += 1;
        }
        const s = stats.get(m.id);
        return {
          monitorId: m.id,
          name: m.name,
          type: m.type,
          target: m.target,
          deleted: m.deleted_at !== null,
          periodSeconds: Math.round(period / 1000),
          downtimeSeconds: Math.round(down / 1000),
          availability: period > 0 ? Math.max(0, 1 - down / period) : null,
          incidents: count,
          checks: s?.checks ?? 0,
          checksPassed: s ? Number(s.passed) : null,
          latencyP50Ms: s?.p50 !== null && s?.p50 !== undefined ? Math.round(Number(s.p50)) : null,
          latencyP95Ms: s?.p95 !== null && s?.p95 !== undefined ? Math.round(Number(s.p95)) : null,
        };
      });

      const totalPeriod = services.reduce((a, s) => a + s.periodSeconds, 0);
      const totalDown = services.reduce((a, s) => a + s.downtimeSeconds, 0);
      return {
        from,
        to: end,
        method: METHOD_NOTE,
        summary: {
          services: services.length,
          availability: totalPeriod > 0 ? 1 - totalDown / totalPeriod : null,
          downtimeSeconds: totalDown,
          incidents: incidents.filter((i) => i.started_at >= from && i.started_at < end).length,
        },
        services,
        incidents: incidents.map((i) => ({
          id: i.id, number: i.number, title: i.title, severity: i.severity, status: i.status, monitorName: i.monitorName,
          startedAt: i.started_at, resolvedAt: i.resolved_at,
          durationSeconds: Math.round(((i.resolved_at ?? new Date()).getTime() - i.started_at.getTime()) / 1000),
        })),
      };
    });
  }

  async availabilityCsv(orgId: string, from: Date, to: Date): Promise<string> {
    const report = await this.availability(orgId, from, to);
    const rows: unknown[][] = [
      ['Service', 'Type', 'Target', 'Availability %', 'Downtime (minutes)', 'Incidents', 'Checks', 'Checks passed %', 'Median response (ms)', '95th percentile (ms)', 'Deleted'],
      ...report.services.map((s) => [
        s.name, s.type, s.target,
        s.availability === null ? '' : (s.availability * 100).toFixed(3),
        (s.downtimeSeconds / 60).toFixed(1), s.incidents, s.checks,
        s.checksPassed === null ? '' : (s.checksPassed * 100).toFixed(2),
        s.latencyP50Ms ?? '', s.latencyP95Ms ?? '', s.deleted ? 'yes' : 'no',
      ]),
      [],
      ['Incident', 'Service', 'Severity', 'Status', 'Started (UTC)', 'Resolved (UTC)', 'Duration (minutes)'],
      ...report.incidents.map((i) => [
        `INC-${i.number}: ${i.title}`, i.monitorName, i.severity.toUpperCase(), i.status,
        i.startedAt.toISOString(), i.resolvedAt?.toISOString() ?? '', (i.durationSeconds / 60).toFixed(1),
      ]),
      [],
      ['Period (UTC)', `${report.from.toISOString()} to ${report.to.toISOString()}`],
      ['Method', report.method],
    ];
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

/**
 * Quotes a CSV cell and neutralises spreadsheet formula injection: a value a
 * customer typed (a service name) that starts with = + - @ or a control
 * character is prefixed with an apostrophe so Excel treats it as text.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}
