import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config/config.js';
import { InMemoryEmailSender } from '../src/email/email.js';

const PASSWORD = 'correct horse battery';

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    SESSION_COOKIE_SECURE: 'false',
    LOGIN_LOCKOUT_THRESHOLD: '3',
    AUTH_RATE_LIMIT_PER_MINUTE: '1000',
    ...extra,
  });
}

function tokenFrom(link: string | undefined): string {
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error('no token in email link');
  return token;
}

/** Cookies from a response, as name -> { value, attributes }. */
function cookies(res: request.Response): Record<string, { value: string; attrs: string }> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const out: Record<string, { value: string; attrs: string }> = {};
  for (const line of raw ?? []) {
    const [pair = '', ...attrs] = line.split(';');
    const index = pair.indexOf('=');
    out[pair.slice(0, index)] = { value: decodeURIComponent(pair.slice(index + 1)), attrs: attrs.join(';').toLowerCase() };
  }
  return out;
}

describe('accounts, sessions and organisations', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const email = new InMemoryEmailSender();

  beforeAll(async () => {
    app = await createApp(config(), { emailSender: email });
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  const newEmail = () => `user-${randomUUID().slice(0, 8)}@example.test`;

  async function registerAndVerify(address = newEmail()) {
    await http.post('/v1/auth/register').send({ email: address, name: 'Test User', password: PASSWORD }).expect(202);
    await http.post('/v1/auth/verify-email').send({ token: tokenFrom(email.lastTo(address)?.link) }).expect(204);
    return address;
  }

  async function signIn(address: string, password = PASSWORD) {
    const res = await http.post('/v1/auth/login').send({ email: address, password }).expect(200);
    const jar = cookies(res);
    const session = jar['wnx_session']!;
    const csrf = jar['wnx_csrf']!;
    return {
      res,
      cookie: `wnx_session=${encodeURIComponent(session.value)}; wnx_csrf=${encodeURIComponent(csrf.value)}`,
      csrf: csrf.value,
      jar,
    };
  }

  it('completes the journey: register, verify, sign in, create an organisation, sign out', async () => {
    const address = await registerAndVerify();
    const { cookie, csrf, jar, res } = await signIn(address);

    expect(res.body.user).toMatchObject({ email: address, name: 'Test User' });
    expect(jar['wnx_session']!.attrs).toContain('httponly');
    expect(jar['wnx_session']!.attrs).toContain('samesite=lax');
    expect(jar['wnx_csrf']!.attrs).not.toContain('httponly');

    const me = await http.get('/v1/me').set('Cookie', cookie).expect(200);
    expect(me.body).toMatchObject({ user: { email: address }, organisations: [] });

    // State-changing request without the CSRF header is refused.
    await http.post('/v1/orgs').set('Cookie', cookie).send({ name: 'Acme Ltd' }).expect(403);

    const created = await http
      .post('/v1/orgs')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Acme Ltd', slug: `acme-${randomUUID().slice(0, 8)}` })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Acme Ltd', role: 'owner', plan_id: 'pilot' });

    const list = await http.get('/v1/orgs').set('Cookie', cookie).expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.body.id, role: 'owner' })]);
    await http.get(`/v1/orgs/${created.body.id}`).set('Cookie', cookie).expect(200);

    await http.post('/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(204);
    await http.get('/v1/me').set('Cookie', cookie).expect(401);
  });

  it('refuses sign-in until the email address is verified', async () => {
    const address = newEmail();
    await http.post('/v1/auth/register').send({ email: address, name: 'Unverified', password: PASSWORD }).expect(202);
    const res = await http.post('/v1/auth/login').send({ email: address, password: PASSWORD }).expect(403);
    expect(res.body.type).toMatch(/email-not-verified$/);
  });

  it('answers an unknown email and a wrong password identically', async () => {
    const address = await registerAndVerify();
    const unknown = await http.post('/v1/auth/login').send({ email: newEmail(), password: PASSWORD });
    const wrong = await http.post('/v1/auth/login').send({ email: address, password: 'wrong password!' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const strip = ({ requestId: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
  });

  it('does not reveal whether an email is already registered', async () => {
    const address = await registerAndVerify();
    const again = await http.post('/v1/auth/register').send({ email: address, name: 'Someone', password: PASSWORD }).expect(202);
    const fresh = await http.post('/v1/auth/register').send({ email: newEmail(), name: 'Someone', password: PASSWORD }).expect(202);
    expect(again.body).toEqual(fresh.body);
    expect(email.lastTo(address)?.kind).toBe('account-exists');
  });

  it('locks an account after repeated failures, even for the right password, and tells the owner', async () => {
    const address = await registerAndVerify();
    for (let i = 0; i < 3; i += 1) {
      await http.post('/v1/auth/login').send({ email: address, password: 'not the password' }).expect(401);
    }
    const locked = await http.post('/v1/auth/login').send({ email: address, password: PASSWORD }).expect(429);
    expect(locked.body.type).toMatch(/too-many-attempts$/);
    expect(email.lastTo(address)?.kind).toBe('account-locked');
  });

  it('resets a password, signs out existing sessions, and accepts each link once', async () => {
    const address = await registerAndVerify();
    const before = await signIn(address);

    await http.post('/v1/auth/password/forgot').send({ email: address }).expect(202);
    const token = tokenFrom(email.lastTo(address)?.link);
    const newPassword = 'a brand new passphrase';
    await http.post('/v1/auth/password/reset').send({ token, password: newPassword }).expect(204);

    await http.get('/v1/me').set('Cookie', before.cookie).expect(401);
    await http.post('/v1/auth/login').send({ email: address, password: PASSWORD }).expect(401);
    await signIn(address, newPassword);

    const reused = await http.post('/v1/auth/password/reset').send({ token, password: 'yet another passphrase' }).expect(400);
    expect(reused.body.type).toMatch(/invalid-token$/);
  });

  it('accepts a verification link only once', async () => {
    const address = newEmail();
    await http.post('/v1/auth/register').send({ email: address, name: 'Once', password: PASSWORD }).expect(202);
    const token = tokenFrom(email.lastTo(address)?.link);
    await http.post('/v1/auth/verify-email').send({ token }).expect(204);
    await http.post('/v1/auth/verify-email').send({ token }).expect(400);
  });

  it('answers another organisation exactly like one that does not exist', async () => {
    const alice = await signIn(await registerAndVerify());
    const bob = await signIn(await registerAndVerify());
    const org = await http
      .post('/v1/orgs')
      .set('Cookie', alice.cookie)
      .set('X-CSRF-Token', alice.csrf)
      .send({ name: 'Alice Co', slug: `alice-${randomUUID().slice(0, 8)}` })
      .expect(201);

    const foreign = await http.get(`/v1/orgs/${org.body.id}`).set('Cookie', bob.cookie).expect(404);
    const missing = await http.get(`/v1/orgs/${randomUUID()}`).set('Cookie', bob.cookie).expect(404);
    expect(foreign.body.detail).toBe(missing.body.detail);
    await http.get('/v1/orgs/not-a-uuid').set('Cookie', bob.cookie).expect(404);
    const bobsList = await http.get('/v1/orgs').set('Cookie', bob.cookie).expect(200);
    expect(bobsList.body.items).toEqual([]);
  });

  it('rejects a taken organisation address with 409', async () => {
    const owner = await signIn(await registerAndVerify());
    const slug = `taken-${randomUUID().slice(0, 8)}`;
    const create = () =>
      http.post('/v1/orgs').set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf).send({ name: 'Taken', slug });
    await create().expect(201);
    const conflict = await create().expect(409);
    expect(conflict.body.errors).toEqual([{ field: 'slug', message: 'is already in use' }]);
  });

  it('validates input at the boundary with field-level errors', async () => {
    const res = await http.post('/v1/auth/register').send({ email: 'not-an-email', name: '', password: 'short' }).expect(422);
    const fields = res.body.errors.map((e: { field: string }) => e.field).sort();
    expect(fields).toEqual(['email', 'name', 'password']);
  });

  it('rejects a forged session cookie', async () => {
    await http.get('/v1/me').set('Cookie', 'wnx_session=forged-token-value-xxxxxxxxxxxx').expect(401);
  });
});

describe('authentication rate limits', () => {
  it('returns 429 once an IP exceeds the per-minute limit', async () => {
    const app = await createApp(config({ AUTH_RATE_LIMIT_PER_MINUTE: '2' }), { emailSender: new InMemoryEmailSender() });
    await app.init();
    const http = request(app.getHttpServer());
    const attempt = () => http.post('/v1/auth/login').send({ email: 'nobody@example.test', password: 'whatever pw' });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    await app.close();
  });
});
