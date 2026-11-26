import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config/config.js';

function testConfig(databaseUrl: string) {
  return loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
}

describe('HTTP foundation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(testConfig(inject('databaseUrl')));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without a version prefix', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('reports readiness when the database is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('answers unknown routes with RFC 9457 problem details', async () => {
    const res = await request(app.getHttpServer()).get('/v1/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'https://docs.watchersnex.app/problems/not-found',
      title: 'Not found',
      status: 404,
      instance: '/v1/does-not-exist',
    });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('keeps a safe caller-supplied request ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/healthz')
      .set('X-Request-Id', 'trace-abc123-DEF')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc123-DEF');
  });

  it('replaces an unsafe request ID instead of echoing it', async () => {
    const res = await request(app.getHttpServer())
      .get('/healthz')
      .set('X-Request-Id', 'bad id with spaces <script>')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not advertise the framework', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('readiness when the database is down', () => {
  it('returns 503 problem details, without leaking connection details', async () => {
    const app = await createApp(testConfig('postgres://nobody:secret-pw@127.0.0.1:1/none'));
    await app.init();
    const res = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(JSON.stringify(res.body)).not.toContain('secret-pw');
    await app.close();
  });
});
