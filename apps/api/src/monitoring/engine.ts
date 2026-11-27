import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { Db, Tx, withAppRole, withTenant } from '../db/database.js';
import type { EmailSender } from '../email/email.js';
import { CheckResult, runDnsCheck, runHttpCheck, runSslCheck } from './checks.js';
import { evaluate, MonitorState, severityFor } from './evaluator.js';
import { PUBLIC_ONLY, TargetPolicy } from './ssrf.js';

export interface DueMonitor {
  id: string;
  organisation_id: string;
  type: 'http' | 'api' | 'ssl' | 'dns';
  target: string;
  config: Record<string, unknown>;
  interval_seconds: number;
  criticality: string;
  scheduled_at: Date;
}

export interface EngineOptions {
  db: Db;
  logger: Logger;
  email: EmailSender;
  region: string;
  appBaseUrl: string;
  policy?: TargetPolicy;
  /** Delay before the local retry of a failed check (Section 7: 15 s). */
  retryDelayMs?: number;
  concurrency?: number;
  batchSize?: number;
}

interface Attempt {
  attempt: number;
  checkedAt: Date;
  result: CheckResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs due checks and evaluates their results. One instance per worker
 * process; several workers can run side by side because claiming is atomic.
 */
export class MonitoringEngine {
  private readonly policy: TargetPolicy;
  private readonly retryDelayMs: number;

  constructor(private readonly options: EngineOptions) {
    this.policy = options.policy ?? PUBLIC_ONLY;
    this.retryDelayMs = options.retryDelayMs ?? 15_000;
  }

  /** Claims and processes one batch; returns how many monitors were checked. */
  async tick(): Promise<number> {
    const due = await withAppRole(this.options.db, async (tx) => {
      const rows = await sql<DueMonitor>`SELECT * FROM wnx_claim_due_monitors(${this.options.batchSize ?? 50})`.execute(tx);
      return rows.rows;
    });
    const concurrency = this.options.concurrency ?? 10;
    for (let i = 0; i < due.length; i += concurrency) {
      await Promise.all(due.slice(i, i + concurrency).map((m) => this.process(m)));
    }
    return due.length;
  }

  async maintainPartitions(): Promise<void> {
    await withAppRole(this.options.db, (tx) => sql`SELECT wnx_maintain_result_partitions(3, 30)`.execute(tx));
  }

  private async process(monitor: DueMonitor): Promise<void> {
    try {
      const attempts: Attempt[] = [{ attempt: 1, checkedAt: new Date(), result: await this.check(monitor) }];
      if (attempts[0]!.result.outcome === 'down') {
        await sleep(this.retryDelayMs);
        attempts.push({ attempt: 2, checkedAt: new Date(), result: await this.check(monitor) });
      }
      await this.record(monitor, attempts);
    } catch (error) {
      // One broken monitor must never stop the others.
      this.options.logger.error({ err: error, monitorId: monitor.id }, 'monitor processing failed');
    }
  }

  private check(monitor: DueMonitor): Promise<CheckResult> {
    const config = monitor.config ?? {};
    switch (monitor.type) {
      case 'http':
      case 'api':
        return runHttpCheck(monitor.target, config, this.policy);
      case 'ssl':
        return runSslCheck(monitor.target, config, this.policy);
      case 'dns':
        return runDnsCheck(monitor.target, config);
    }
  }

  private async record(monitor: DueMonitor, attempts: Attempt[]): Promise<void> {
    const final = attempts[attempts.length - 1]!;
    const notify = await withTenant(this.options.db, monitor.organisation_id, async (tx) => {
      for (const a of attempts) {
        await tx
          .insertInto('check_results')
          .values({
            monitor_id: monitor.id,
            organisation_id: monitor.organisation_id,
            region: this.options.region,
            scheduled_at: monitor.scheduled_at,
            checked_at: a.checkedAt,
            attempt: a.attempt,
            outcome: a.result.outcome,
            failure_class: a.result.failureClass ?? null,
            status_code: a.result.statusCode ?? null,
            latency_ms: a.result.latencyMs,
            timings_ms: a.result.timings ? JSON.stringify(a.result.timings) : null,
            detail: JSON.stringify({ message: a.result.message, finalUrl: a.result.finalUrl }),
          })
          .execute();
      }

      // Lock this monitor's state row so concurrent evaluations serialise.
      await tx
        .insertInto('monitor_states')
        .values({ monitor_id: monitor.id, organisation_id: monitor.organisation_id })
        .onConflict((oc) => oc.column('monitor_id').doNothing())
        .execute();
      const current = await tx
        .selectFrom('monitor_states')
        .selectAll()
        .where('monitor_id', '=', monitor.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.state === 'paused') return undefined;

      const { next, action } = evaluate(
        {
          state: current.state as MonitorState,
          consecutiveFailures: current.consecutive_failures,
          consecutiveSuccesses: current.consecutive_successes,
          firstFailureAt: current.first_failure_at,
        },
        final.result.outcome,
        attempts[0]!.checkedAt,
      );

      let incidentId = current.open_incident_id;
      let event: { kind: 'opened' | 'resolved'; incidentId: string; number: number; title: string; severity: string; startedAt: Date } | undefined;

      if (action === 'open-incident') {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${monitor.organisation_id}))`.execute(tx);
        const numberRow = await tx
          .selectFrom('incidents')
          .select((eb) => eb.fn.coalesce(eb.fn.max('number'), eb.lit(0)).as('max'))
          .executeTakeFirstOrThrow();
        const name = await this.monitorName(tx, monitor.id);
        incidentId = randomUUID();
        const number = Number(numberRow.max) + 1;
        const title = `${name} is down`;
        const severity = severityFor(monitor.criticality);
        const startedAt = next.firstFailureAt ?? final.checkedAt;
        await tx
          .insertInto('incidents')
          .values({
            id: incidentId, organisation_id: monitor.organisation_id, number, monitor_id: monitor.id, title, severity,
            status: 'open', started_at: startedAt, detected_at: final.checkedAt,
          })
          .execute();
        await this.incidentEvent(tx, monitor.organisation_id, incidentId, 'opened', {
          message: final.result.message, failureClass: final.result.failureClass, region: this.options.region,
        });
        event = { kind: 'opened', incidentId, number, title, severity, startedAt };
      }

      if (action === 'resolve-incident' && incidentId) {
        const incident = await tx
          .updateTable('incidents')
          .set({ status: 'resolved', resolved_at: final.checkedAt })
          .where('id', '=', incidentId)
          .where('status', '<>', 'resolved')
          .returning(['id', 'number', 'title', 'severity', 'started_at'])
          .executeTakeFirst();
        if (incident) {
          await this.incidentEvent(tx, monitor.organisation_id, incident.id, 'resolved', { automatic: true, message: final.result.message });
          event = { kind: 'resolved', incidentId: incident.id, number: incident.number, title: incident.title, severity: incident.severity, startedAt: incident.started_at };
        }
        incidentId = null;
      }

      await tx
        .updateTable('monitor_states')
        .set({
          state: next.state,
          consecutive_failures: next.consecutiveFailures,
          consecutive_successes: next.consecutiveSuccesses,
          first_failure_at: next.firstFailureAt,
          open_incident_id: incidentId,
          last_checked_at: final.checkedAt,
          last_outcome: final.result.outcome,
          last_status_code: final.result.statusCode ?? null,
          last_latency_ms: final.result.latencyMs,
          last_failure_class: final.result.failureClass ?? null,
          last_detail: final.result.message,
          version: sql`version + 1`,
        })
        .where('monitor_id', '=', monitor.id)
        .execute();

      if (!event) return undefined;
      const recipients = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.email')
        .where('m.role', 'in', ['owner', 'admin'])
        .where('u.status', '=', 'active')
        .execute();
      return { event, recipients: recipients.map((r) => r.email), result: final.result };
    });

    if (notify) await this.sendIncidentEmails(monitor, notify.event, notify.recipients, notify.result);
  }

  private async monitorName(tx: Tx, monitorId: string): Promise<string> {
    const row = await tx.selectFrom('monitors').select('name').where('id', '=', monitorId).executeTakeFirst();
    return row?.name ?? 'A monitored service';
  }

  private async incidentEvent(tx: Tx, organisationId: string, incidentId: string, type: 'opened' | 'resolved' | 'notified', details: Record<string, unknown>) {
    await tx
      .insertInto('incident_events')
      .values({ id: randomUUID(), organisation_id: organisationId, incident_id: incidentId, type, details: JSON.stringify(details) })
      .execute();
  }

  /** Delivery failures are logged per recipient and never undo the incident. */
  private async sendIncidentEmails(
    monitor: DueMonitor,
    event: { kind: 'opened' | 'resolved'; incidentId: string; number: number; title: string; severity: string; startedAt: Date },
    recipients: string[],
    result: CheckResult,
  ): Promise<void> {
    const link = `${this.options.appBaseUrl}/o/${monitor.organisation_id}/incidents/${event.incidentId}`;
    const severity = event.severity.toUpperCase();
    const subject =
      event.kind === 'opened'
        ? `[${severity}] INC-${event.number}: ${event.title}`
        : `[Resolved] INC-${event.number}: ${event.title.replace(/ is down$/, ' has recovered')}`;
    const text =
      event.kind === 'opened'
        ? `${event.title}. Failing since ${event.startedAt.toISOString()} (UTC), confirmed from ${this.options.region}.\nLatest check: ${result.message}\n\nOpen the incident: ${link}`
        : `${event.title.replace(/ is down$/, '')} is responding normally again.\nLatest check: ${result.message}\n\nIncident timeline: ${link}`;
    let sent = 0;
    for (const to of recipients) {
      try {
        await this.options.email.send({ kind: event.kind === 'opened' ? 'incident-opened' : 'incident-resolved', to, subject, text });
        sent += 1;
      } catch (error) {
        this.options.logger.error({ err: error, incidentId: event.incidentId }, 'incident email failed');
      }
    }
    await withTenant(this.options.db, monitor.organisation_id, (tx) =>
      this.incidentEvent(tx, monitor.organisation_id, event.incidentId, 'notified', { channel: 'email', event: event.kind, recipients: sent }),
    );
  }
}
