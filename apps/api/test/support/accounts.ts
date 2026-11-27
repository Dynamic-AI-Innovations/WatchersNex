import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import type { InMemoryEmailSender } from '../../src/email/email.js';

export const PASSWORD = 'correct horse battery';

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
  csrf: string;
}

function parseCookies(res: request.Response) {
  const cookies = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('wnx_csrf='))!.split('=')[1]!);
  return { cookie: cookies.join('; '), csrf };
}

/** Registers, verifies and signs in a fresh user (lower-case address, as the API stores it). */
export async function createUser(http: ReturnType<typeof request>, email: InMemoryEmailSender, label: string, password = PASSWORD): Promise<TestUser> {
  const address = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  await http.post('/v1/auth/register').send({ email: address, name: label, password }).expect(202);
  const token = new URL(email.lastTo(address)!.link!).searchParams.get('token');
  await http.post('/v1/auth/verify-email').send({ token }).expect(204);
  const res = await http.post('/v1/auth/login').send({ email: address, password }).expect(200);
  return { id: res.body.user.id, email: address, ...parseCookies(res) };
}

export async function signIn(http: ReturnType<typeof request>, address: string, password: string): Promise<Omit<TestUser, 'email'>> {
  const res = await http.post('/v1/auth/login').send({ email: address, password }).expect(200);
  return { id: res.body.user.id, ...parseCookies(res) };
}

/** Request helpers that carry the user's cookies and CSRF header. */
export function as(http: ReturnType<typeof request>, user: { cookie: string; csrf: string }) {
  return {
    get: (path: string) => http.get(path).set('Cookie', user.cookie),
    post: (path: string, body?: object) => http.post(path).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf).send(body ?? {}),
    patch: (path: string, body?: object) => http.patch(path).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf).send(body ?? {}),
    put: (path: string, body?: object) => http.put(path).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf).send(body ?? {}),
    delete: (path: string) => http.delete(path).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf),
  };
}
