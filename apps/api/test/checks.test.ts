import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHttpCheck } from '../src/monitoring/checks.js';
import { Fixture, LOOPBACK_FIXTURE_ONLY, startFixture } from './support/fixture.js';

describe('HTTP check', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });
  beforeEach(() => {
    Object.assign(fixture, { status: 200, body: 'ok WatchersNex fixture', delayMs: 0, redirectTo: undefined });
  });

  it('reports up with status, latency and timings', async () => {
    const result = await runHttpCheck(fixture.url, {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'up', statusCode: 200 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.timings?.total).toBeDefined();
  });

  it('reports a 500 as a status failure', async () => {
    fixture.status = 500;
    const result = await runHttpCheck(fixture.url, {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'status', statusCode: 500 });
  });

  it('treats HTTP 200 without the expected text as a failure', async () => {
    fixture.body = 'maintenance page';
    const result = await runHttpCheck(fixture.url, { keyword: 'WatchersNex' }, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'assertion', statusCode: 200 });
  });

  it('times out a slow response', async () => {
    fixture.delayMs = 2500;
    const result = await runHttpCheck(fixture.url, { timeoutMs: 1000 }, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'timeout' });
  });

  it('re-checks every redirect hop and refuses one into a private address', async () => {
    fixture.redirectTo = 'http://127.0.0.2/internal';
    const result = await runHttpCheck(fixture.url, {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'blocked' });
    expect(result.message).toMatch(/private/);
  });

  it('refuses a redirect to cloud metadata', async () => {
    fixture.redirectTo = 'http://169.254.169.254/latest/meta-data/';
    const result = await runHttpCheck(fixture.url, {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'blocked' });
  });

  it('with the production policy, refuses the local fixture outright', async () => {
    const hitsBefore = fixture.hits;
    const result = await runHttpCheck(fixture.url);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'blocked' });
    expect(fixture.hits).toBe(hitsBefore); // no request was ever sent
  });

  it('rejects a low port before connecting', async () => {
    const result = await runHttpCheck('http://127.0.0.1:1/', {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'blocked' });
  });

  it('reports a refused connection', async () => {
    const closed = await startFixture();
    const port = closed.port;
    await closed.close();
    const result = await runHttpCheck(`http://127.0.0.1:${port}/`, {}, LOOPBACK_FIXTURE_ONLY);
    expect(result).toMatchObject({ outcome: 'down', failureClass: 'connect' });
  });
});
