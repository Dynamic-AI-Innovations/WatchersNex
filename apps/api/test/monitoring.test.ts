import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pino from 'pino';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config/config.js';
import { createDb, Db } from '../src/db/database.js';
import { InMemoryEmailSender } from '../src/email/email.js';
import { MonitoringEngine } from '../src/monitoring/engine.js';
import { Fixture, LOOPBACK_FIXTURE_ONLY, startFixture } from './support/fixture.js';

const PASSWORD = 'correct horse battery';

describe('monitoring engine and incident lifecycle', () => {
  const url = inject('databaseUrl');
  const email = new InMemoryEmailSender();
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: Pool;
  let db: Db;
  let engine: MonitoringEngine;
  let fixture: Fixture;
  let owner: { cookie: string; csrf: string; email: string };
  let orgId: string;
  let monitorId: string;

  async function account(name: string) {
    const address = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
    await http.post('/v1/auth/register').send({ email: address, name, password: PASSWORD }).expect(202);
    const token = new URL(email.lastTo(address)!.link!).searchParams.get('token');
    await http.post('/v1/auth/verify-email').send({ token }).expect(204);
    const res = await http.post('/v1/auth/login').send({ email: address, password: PASSWORD }).expect(200);
    const cookies = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('wnx_csrf='))!.split('=')[1]!);
    return { cookie: cookies.join('; '), csrf, email: address };
  }

  const as = (who: { cookie: string; csrf: string }) => ({
    get: (path: string) => http.get(path).set('Cookie', who.cookie),
    post: (path: string, body?: object) => http.post(path).set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf).send(body ?? {}),
  });

  /** Makes the monitor due now and runs one engine pass. */
  async function tick() {
    await admin.query(`UPDATE monitors SET next_check_at = now() - interval '1 second' WHERE id = $1`, [monitorId]);
    await engine.tick();
  }

  async function state() {
    return (await as(owner).get(`/v1/orgs/${orgId}/monitors/${monitorId}`).expect(200)).body;
  }

  beforeAll(async () => {
    fixture = await startFixture();
    const config = loadConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent', NODE_ENV: 'test', SESSION_COOKIE_SECURE: 'false', AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
    app = await createApp(config, { emailSender: email, monitorPolicy: LOOPBACK_FIXTURE_ONLY });
    await app.init();
    http = request(app.getHttpServer());
    admin = new Pool({ connectionString: url, max: 1 });
    db = createDb(url, 4).db;
    engine = new MonitoringEngine({
      db, email, logger: pino({ level: 'silent' }), region: 'test-region', appBaseUrl: 'https://app.test',
      policy: LOOPBACK_FIXTURE_ONLY, retryDelayMs: 0,
    });

    owner = await account('Owner');
    orgId = (await as(owner).post('/v1/orgs', { name: 'Monitoring Co', slug: `mon-${randomUUID().slice(0, 8)}` }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await admin.end();
    await fixture.close();
  });

  it('creates a monitor only with an authorisation attestation', async () => {
    const base = { type: 'http', name: 'Fixture site', target: fixture.url, intervalSeconds: 60 };
    const refused = await as(owner).post(`/v1/orgs/${orgId}/monitors`, base).expect(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'authorisationAttested' })]);

    const created = await as(owner).post(`/v1/orgs/${orgId}/monitors`, { ...base, authorisationAttested: true }).expect(201);
    expect(created.body).toMatchObject({ name: 'Fixture site', status: 'pending', intervalSeconds: 60 });
    monitorId = created.body.id;
  });

  it('refuses private and metadata targets when the monitor is saved', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://127.0.0.2/']) {
      const res = await as(owner)
        .post(`/v1/orgs/${orgId}/monitors`, { type: 'http', name: 'Bad', target, intervalSeconds: 60, authorisationAttested: true })
        .expect(422);
      expect(res.body.type).toMatch(/target-rejected$/);
    }
  });

  it('records a healthy check', async () => {
    fixture.status = 200;
    await tick();
    const monitor = await state();
    expect(monitor).toMatchObject({ status: 'up', lastOutcome: 'up', lastStatusCode: 200 });
    expect(monitor.stats24h.checks).toBe(1);
  });

  it('suspects on the first failure and opens one incident on the second, emailing the owner', async () => {
    fixture.status = 500;
    await tick();
    expect((await state()).status).toBe('suspected');
    expect(email.sent.filter((m) => m.kind === 'incident-opened')).toHaveLength(0);

    await tick();
    const monitor = await state();
    expect(monitor.status).toBe('down');
    expect(monitor.openIncidentId).toBeTruthy();

    const alert = email.lastTo(owner.email);
    expect(alert).toMatchObject({ kind: 'incident-opened' });
    expect(alert!.subject).toMatch(/^\[SEV2\] INC-1: Fixture site is down$/);

    const overview = (await as(owner).get(`/v1/orgs/${orgId}/overview`).expect(200)).body;
    expect(overview.monitors).toMatchObject({ total: 1, down: 1 });
    expect(overview.openIncidents).toHaveLength(1);
  });

  it('lets a responder acknowledge and annotate, and enforces roles', async () => {
    const incidentId = (await state()).openIncidentId;
    const viewer = await account('Viewer');
    const viewerId = (await as(viewer).get('/v1/me').expect(200)).body.user.id;
    await admin.query(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgId, viewerId]);

    await as(viewer).get(`/v1/orgs/${orgId}/incidents/${incidentId}`).expect(200);
    await as(viewer).post(`/v1/orgs/${orgId}/incidents/${incidentId}/acknowledge`).expect(403);
    await as(viewer).post(`/v1/orgs/${orgId}/monitors`, { type: 'http', name: 'x', target: fixture.url, intervalSeconds: 60, authorisationAttested: true }).expect(403);

    const acked = await as(owner).post(`/v1/orgs/${orgId}/incidents/${incidentId}/acknowledge`).expect(201);
    expect(acked.body.status).toBe('acknowledged');
    await as(owner).post(`/v1/orgs/${orgId}/incidents/${incidentId}/acknowledge`).expect(409);
    await as(owner).post(`/v1/orgs/${orgId}/incidents/${incidentId}/notes`, { text: 'Restarting the app server.' }).expect(201);
  });

  it('resolves automatically after two healthy checks and records the full timeline', async () => {
    const incidentId = (await state()).openIncidentId;
    fixture.status = 200;
    await tick();
    expect((await state()).status).toBe('recovering');
    await tick();
    expect((await state())).toMatchObject({ status: 'up', openIncidentId: null });

    const incident = (await as(owner).get(`/v1/orgs/${orgId}/incidents/${incidentId}`).expect(200)).body;
    expect(incident.status).toBe('resolved');
    expect(incident.timeline.map((e: { type: string }) => e.type)).toEqual(['opened', 'notified', 'acknowledged', 'note', 'resolved', 'notified']);
    expect(email.lastTo(owner.email)).toMatchObject({ kind: 'incident-resolved' });
  });

  it('keeps one organisation out of another organisation\'s monitors and incidents', async () => {
    const outsider = await account('Outsider');
    await as(outsider).get(`/v1/orgs/${orgId}/monitors/${monitorId}`).expect(404);
    await as(outsider).get(`/v1/orgs/${orgId}/incidents`).expect(404);
    const res = await admin.query(`SELECT count(*)::int AS n FROM check_results WHERE monitor_id = $1`, [monitorId]);
    expect(res.rows[0].n).toBeGreaterThan(0);
  });

  it('stops checking a paused monitor', async () => {
    await as(owner).post(`/v1/orgs/${orgId}/monitors/${monitorId}/pause`).expect(201);
    const before = fixture.hits;
    await tick();
    expect(fixture.hits).toBe(before);
    expect((await state()).status).toBe('paused');
  });
});
