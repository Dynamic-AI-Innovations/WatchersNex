import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { APP_ROLE, createDb, Db, withTenant } from '../src/db/database.js';

/**
 * Proves FR-003 / threat T-03 at the database layer: a transaction scoped to
 * one organisation can't read, write or even detect another organisation's rows.
 */
describe('tenant isolation (row-level security)', () => {
  const url = inject('databaseUrl');
  let admin: Pool; // test fixture setup only, as the migration owner
  let db: Db;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    // Pool of one connection, so the "reused connection" test really reuses it.
    db = createDb(url, 1).db;

    await admin.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES
         ($1, $3, 'User A', 'x'), ($2, $4, 'User B', 'x')`,
      [userA, userB, `a-${userA}@example.test`, `b-${userB}@example.test`],
    );
    await admin.query(
      `INSERT INTO organisations (id, name, slug, plan_id) VALUES
         ($1, 'Org A', $3, 'pilot'), ($2, 'Org B', $4, 'pilot')`,
      [orgA, orgB, `org-a-${orgA.slice(0, 8)}`, `org-b-${orgB.slice(0, 8)}`],
    );
    await admin.query(
      `INSERT INTO memberships (organisation_id, user_id, role) VALUES
         ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [orgA, userA, orgB, userB],
    );
  });

  afterAll(async () => {
    await db.destroy();
    await admin.end();
  });

  it('returns only the current organisation’s memberships', async () => {
    const rows = await withTenant(db, orgA, (tx) =>
      tx.selectFrom('memberships').selectAll().execute(),
    );
    expect(rows.map((r) => r.organisation_id)).toEqual([orgA]);
  });

  it('cannot see another organisation even by its exact ID', async () => {
    const rows = await withTenant(db, orgA, (tx) =>
      tx.selectFrom('organisations').selectAll().where('id', '=', orgB).execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into another organisation', async () => {
    await expect(
      withTenant(db, orgA, (tx) =>
        tx
          .insertInto('memberships')
          .values({ organisation_id: orgB, user_id: userA, role: 'admin' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move a row from its own organisation into another', async () => {
    await expect(
      withTenant(db, orgA, (tx) =>
        tx
          .updateTable('memberships')
          .set({ organisation_id: orgB })
          .where('user_id', '=', userA)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('sees nothing when no organisation is set, even on a reused connection', async () => {
    // First use the single pooled connection with a tenant set...
    await withTenant(db, orgA, (tx) => tx.selectFrom('memberships').selectAll().execute());
    // ...then run as the app role with no tenant. current_setting now returns ''.
    const rows = await db.transaction().execute(async (tx) => {
      await sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`.execute(tx);
      return tx.selectFrom('organisations').selectAll().execute();
    });
    expect(rows).toHaveLength(0);
  });

  it('keeps the audit log append-only for the application', async () => {
    const eventId = randomUUID();
    await withTenant(db, orgA, (tx) =>
      sql`INSERT INTO audit_events (id, organisation_id, actor_type, action, resource_type)
          VALUES (${eventId}, ${orgA}, 'system', 'test.event', 'test')`.execute(tx),
    );
    await expect(
      withTenant(db, orgA, (tx) =>
        sql`UPDATE audit_events SET action = 'tampered' WHERE id = ${eventId}`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, orgA, (tx) =>
        sql`DELETE FROM audit_events WHERE id = ${eventId}`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects a tenant ID that is not a UUID', async () => {
    await expect(withTenant(db, "x' OR '1'='1", async () => 1)).rejects.toThrow(/must be a UUID/);
  });
});
