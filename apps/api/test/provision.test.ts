import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, withTenant } from '../src/db/database.js';
import { ensureAppLoginRole } from '../src/db/provision.js';

/**
 * The API's production login role must be subject to row-level security on
 * its own, with no help from SET ROLE: this is the second guard of ADR-003.
 */
describe('API login role provisioning', () => {
  const ownerUrl = inject('databaseUrl');
  const role = `wnx_api_test_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  let owner: Client;
  let appUrl: string;

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    const url = new URL(ownerUrl);
    url.username = role;
    url.password = password;
    appUrl = url.toString();
  });

  afterAll(async () => {
    await owner.query(`REVOKE ALL ON DATABASE ${new URL(ownerUrl).pathname.slice(1)} FROM ${role}`);
    await owner.query(`DROP OWNED BY ${role}`);
    await owner.query(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  });

  it('creates a role that is not a superuser and cannot bypass RLS', async () => {
    await ensureAppLoginRole(owner, role, password);
    const { rows } = await owner.query(
      'SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [role],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
  });

  it('is idempotent and can rotate the password', async () => {
    const rotated = randomBytes(24).toString('hex');
    await ensureAppLoginRole(owner, role, rotated);
    await ensureAppLoginRole(owner, role, password);
  });

  it('sees no tenant rows on its own, even without SET ROLE', async () => {
    const orgId = randomUUID();
    await owner.query(
      `INSERT INTO organisations (id, name, slug, plan_id) VALUES ($1, 'Provision Org', $2, 'pilot')`,
      [orgId, `prov-${orgId.slice(0, 8)}`],
    );
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      const plain = await app.query('SELECT count(*)::int AS n FROM organisations');
      expect(plain.rows[0].n).toBe(0);
    } finally {
      await app.end();
    }

    // And through the normal tenant path, it sees exactly its own organisation.
    const { db } = createDb(appUrl, 1);
    try {
      const rows = await withTenant(db, orgId, (tx) =>
        tx.selectFrom('organisations').select('id').execute(),
      );
      expect(rows).toEqual([{ id: orgId }]);
      const superuser = await sql<{ s: string }>`SELECT current_setting('is_superuser') AS s`.execute(db);
      expect(superuser.rows[0]?.s).toBe('off');
    } finally {
      await db.destroy();
    }
  });

  it('rejects unsafe role names and short passwords', async () => {
    await expect(ensureAppLoginRole(owner, 'x; DROP TABLE users', password)).rejects.toThrow(
      /invalid role name/,
    );
    await expect(ensureAppLoginRole(owner, role, 'short')).rejects.toThrow(/at least 32/);
  });
});
