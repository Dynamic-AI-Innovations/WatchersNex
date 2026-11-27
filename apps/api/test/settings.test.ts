import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config/config.js';
import { createDb, Db, withTenant } from '../src/db/database.js';
import { InMemoryEmailSender } from '../src/email/email.js';
import { resolveRecipients } from '../src/monitoring/alert-policies.service.js';
import { csvCell } from '../src/monitoring/reports.service.js';
import { as, createUser, PASSWORD, signIn, TestUser } from './support/accounts.js';
import { LOOPBACK_FIXTURE_ONLY } from './support/fixture.js';

describe('settings: members, invitations, alerts, reports, audit, account', () => {
  const url = inject('databaseUrl');
  const email = new InMemoryEmailSender();
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: Pool;
  let db: Db;
  let owner: TestUser;
  let orgId: string;
  let base: string;

  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent', NODE_ENV: 'test', SESSION_COOKIE_SECURE: 'false', AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
    app = await createApp(config, { emailSender: email, monitorPolicy: LOOPBACK_FIXTURE_ONLY });
    await app.init();
    http = request(app.getHttpServer());
    admin = new Pool({ connectionString: url, max: 1 });
    db = createDb(url, 2).db;
    owner = await createUser(http, email, 'Owner');
    orgId = (await as(http, owner).post('/v1/orgs', { name: 'Settings Co', slug: `set-${randomUUID().slice(0, 8)}` }).expect(201)).body.id;
    base = `/v1/orgs/${orgId}`;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await admin.end();
  });

  async function invitedMember(role: 'admin' | 'operator' | 'viewer', label: string) {
    const user = await createUser(http, email, label);
    await as(http, owner).post(`${base}/invitations`, { email: user.email, role }).expect(201);
    const token = new URL(email.lastTo(user.email)!.link!).searchParams.get('token');
    await as(http, user).post('/v1/invitations/accept', { token }).expect(200);
    return user;
  }

  describe('invitations', () => {
    it('invites by email; only the invited address can accept; the link works once', async () => {
      const invitee = await createUser(http, email, 'Invitee');
      const stranger = await createUser(http, email, 'Stranger');
      await as(http, owner).post(`${base}/invitations`, { email: invitee.email, role: 'operator' }).expect(201);
      const message = email.lastTo(invitee.email)!;
      expect(message.kind).toBe('invitation');
      const token = new URL(message.link!).searchParams.get('token')!;

      const preview = await http.get(`/v1/invitations/preview?token=${token}`).expect(200);
      expect(preview.body).toMatchObject({ organisationName: 'Settings Co', role: 'operator', email: invitee.email });

      await as(http, stranger).post('/v1/invitations/accept', { token }).expect(400);
      const accepted = await as(http, invitee).post('/v1/invitations/accept', { token }).expect(200);
      expect(accepted.body.organisationId).toBe(orgId);
      await as(http, invitee).post('/v1/invitations/accept', { token }).expect(400);

      const list = (await as(http, owner).get(`${base}/members`).expect(200)).body;
      expect(list.members).toEqual(expect.arrayContaining([expect.objectContaining({ email: invitee.email, role: 'operator' })]));
      expect(list.invitations.find((i: { email: string }) => i.email === invitee.email)).toBeUndefined();
    });

    it('refuses to invite someone who is already a member, and lets admins revoke a pending invite', async () => {
      await as(http, owner).post(`${base}/invitations`, { email: owner.email, role: 'viewer' }).expect(409);
      await as(http, owner).post(`${base}/invitations`, { email: 'pending@example.test', role: 'viewer' }).expect(201);
      const pending = (await as(http, owner).get(`${base}/members`).expect(200)).body.invitations.find((i: { email: string }) => i.email === 'pending@example.test');
      await as(http, owner).delete(`${base}/invitations/${pending.id}`).expect(204);
      const token = new URL(email.lastTo('pending@example.test')!.link!).searchParams.get('token');
      await http.get(`/v1/invitations/preview?token=${token}`).expect(400);
    });

    it('cannot be used to invite as owner, and viewers cannot invite', async () => {
      await as(http, owner).post(`${base}/invitations`, { email: 'x@example.test', role: 'owner' }).expect(422);
      const viewer = await invitedMember('viewer', 'Viewer');
      await as(http, viewer).post(`${base}/invitations`, { email: 'y@example.test', role: 'viewer' }).expect(403);
    });
  });

  describe('roles and ownership', () => {
    it('keeps ownership changes with owners and never leaves an organisation without one', async () => {
      const adminUser = await invitedMember('admin', 'Admin');
      const operator = await invitedMember('operator', 'Operator');

      // Admins manage non-owner roles but cannot touch ownership.
      await as(http, adminUser).patch(`${base}/members/${operator.id}`, { role: 'viewer' }).expect(200);
      await as(http, adminUser).patch(`${base}/members/${operator.id}`, { role: 'owner' }).expect(403);
      await as(http, adminUser).patch(`${base}/members/${owner.id}`, { role: 'viewer' }).expect(403);
      await as(http, adminUser).delete(`${base}/members/${owner.id}`).expect(403);

      // The last owner can neither be demoted nor leave.
      await as(http, owner).patch(`${base}/members/${owner.id}`, { role: 'admin' }).expect(409);
      await as(http, owner).delete(`${base}/members/${owner.id}`).expect(409);

      // With a second owner, the first may step down.
      await as(http, owner).patch(`${base}/members/${adminUser.id}`, { role: 'owner' }).expect(200);
      await as(http, owner).patch(`${base}/members/${owner.id}`, { role: 'admin' }).expect(200);
      await as(http, adminUser).patch(`${base}/members/${owner.id}`, { role: 'owner' }).expect(200);

      // A member may leave; access ends immediately.
      await as(http, operator).delete(`${base}/members/${operator.id}`).expect(204);
      await as(http, operator).get(`${base}/monitors`).expect(404);
    });
  });

  describe('alert rules', () => {
    it('validates recipients and routes incidents by severity and event', async () => {
      await as(http, owner).post(`${base}/alert-policies`, { name: 'Empty' }).expect(422);
      await as(http, owner).post(`${base}/alert-policies`, { name: 'Outsider', memberIds: [randomUUID()] }).expect(422);

      // No policies yet: owners and admins are the default recipients.
      const defaults = await withTenant(db, orgId, (tx) => resolveRecipients(tx, 'sev3', 'opened'));
      expect(defaults).toContain(owner.email);

      await as(http, owner).post(`${base}/alert-policies`, { name: 'Critical only', minSeverity: 'sev1', memberIds: [owner.id], notifyOn: ['opened'] }).expect(201);
      await as(http, owner).post(`${base}/alert-policies`, { name: 'On-call', minSeverity: 'sev2', externalEmails: ['oncall@example.test'] }).expect(201);

      const sev1 = await withTenant(db, orgId, (tx) => resolveRecipients(tx, 'sev1', 'opened'));
      expect(sev1.sort()).toEqual([owner.email, 'oncall@example.test'].sort());
      const sev2Resolved = await withTenant(db, orgId, (tx) => resolveRecipients(tx, 'sev2', 'resolved'));
      expect(sev2Resolved).toEqual(['oncall@example.test']);
      const sev3 = await withTenant(db, orgId, (tx) => resolveRecipients(tx, 'sev3', 'opened'));
      expect(sev3).toEqual([]);

      const list = (await as(http, owner).get(`${base}/alert-policies`).expect(200)).body.items;
      expect(list.map((p: { name: string }) => p.name)).toEqual(['Critical only', 'On-call']);
    });
  });

  describe('reports', () => {
    it('computes availability from incident time within the period', async () => {
      const monitorId = randomUUID();
      const dayStart = new Date(Date.UTC(2026, 10, 20));
      const dayEnd = new Date(Date.UTC(2026, 10, 21));
      await admin.query(
        `INSERT INTO monitors (id, organisation_id, name, type, target, interval_seconds, created_by, authorisation_attested_at, created_at, enabled)
         VALUES ($1, $2, '=HYPERLINK("http://evil")', 'http', 'https://example.com/', 60, $3, now(), $4, false)`,
        [monitorId, orgId, owner.id, new Date(dayStart.getTime() - 86_400_000)],
      );
      // 30 minutes of downtime inside the day, plus an incident that started the day before and ran 15 minutes into it.
      await admin.query(
        `INSERT INTO incidents (id, organisation_id, number, monitor_id, title, severity, status, started_at, detected_at, resolved_at) VALUES
         ($1, $2, 901, $3, 'Down', 'sev2', 'resolved', $4, $4, $5),
         ($6, $2, 902, $3, 'Down', 'sev2', 'resolved', $7, $7, $8)`,
        [randomUUID(), orgId, monitorId, new Date(dayStart.getTime() + 3_600_000), new Date(dayStart.getTime() + 3_600_000 + 1_800_000),
         randomUUID(), new Date(dayStart.getTime() - 600_000), new Date(dayStart.getTime() + 900_000)],
      );

      const report = (await as(http, owner).get(`${base}/reports/availability?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`).expect(200)).body;
      const row = report.services.find((s: { monitorId: string }) => s.monitorId === monitorId);
      expect(row.periodSeconds).toBe(86_400);
      expect(row.downtimeSeconds).toBe(2_700); // 30 min + 15 min overlapping
      expect(row.availability).toBeCloseTo(1 - 2_700 / 86_400, 6);
      expect(row.incidents).toBe(1); // only the one that started inside the day
      expect(report.method).toMatch(/first failing check/);

      const csv = await as(http, owner).get(`${base}/reports/availability.csv?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="watchersnex-availability-2026-11-20-to-2026-11-21.csv"/);
      expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    });

    it('rejects a period longer than 92 days or reversed', async () => {
      await as(http, owner).get(`${base}/reports/availability?from=2026-01-01&to=2026-06-01`).expect(422);
      await as(http, owner).get(`${base}/reports/availability?from=2026-06-01&to=2026-01-01`).expect(422);
    });

    it('escapes formula-like CSV cells', () => {
      expect(csvCell('=1+1')).toBe("'=1+1");
      expect(csvCell('+44 20')).toBe("'+44 20");
      expect(csvCell('-cmd')).toBe("'-cmd");
      expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell('a,b')).toBe('"a,b"');
    });
  });

  describe('organisation, plan, audit log', () => {
    it('lets only the owner rename the organisation and validates the time zone', async () => {
      const adminUser = await invitedMember('admin', 'Admin2');
      await as(http, adminUser).patch(base, { name: 'Renamed' }).expect(403);
      await as(http, owner).patch(base, { timezone: 'Mars/Olympus' }).expect(422);
      const updated = await as(http, owner).patch(base, { name: 'Settings Co Ltd', timezone: 'Africa/Lagos' }).expect(200);
      expect(updated.body).toMatchObject({ name: 'Settings Co Ltd', timezone: 'Africa/Lagos' });
    });

    it('reports plan limits next to usage', async () => {
      const res = (await as(http, owner).get(`${base}/plan`).expect(200)).body;
      expect(res.plan).toMatchObject({ id: 'pilot', limits: { monitors: 50 } });
      expect(res.usage.members).toBeGreaterThan(1);
    });

    it('shows the audit log to admins only, newest first, with paging', async () => {
      const page = (await as(http, owner).get(`${base}/audit-events?limit=3`).expect(200)).body;
      expect(page.items).toHaveLength(3);
      expect(page.nextBefore).toBeTruthy();
      const actions = (await as(http, owner).get(`${base}/audit-events?limit=100`).expect(200)).body.items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['organisation.create', 'member.invite', 'member.join', 'member.role_change', 'alert_policy.create', 'organisation.update']));
      const viewer = await invitedMember('viewer', 'Viewer2');
      await as(http, viewer).get(`${base}/audit-events`).expect(403);
    });
  });

  describe('account', () => {
    it('updates the profile name', async () => {
      const res = await as(http, owner).patch('/v1/me', { name: 'Olu Owner' }).expect(200);
      expect(res.body.user.name).toBe('Olu Owner');
      expect((await as(http, owner).get('/v1/me').expect(200)).body.user.name).toBe('Olu Owner');
    });

    it('changes the password only with the current one, and signs out other sessions', async () => {
      const user = await createUser(http, email, 'Mover');
      const otherDevice = await signIn(http, user.email, PASSWORD);
      await as(http, user).post('/v1/me/password', { currentPassword: 'wrong password', newPassword: 'a new passphrase here' }).expect(422);
      await as(http, user).post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'a new passphrase here' }).expect(204);
      await as(http, user).get('/v1/me').expect(200); // this session survives
      await as(http, otherDevice).get('/v1/me').expect(401); // the other one ends
      await signIn(http, user.email, 'a new passphrase here');
    });
  });
});
