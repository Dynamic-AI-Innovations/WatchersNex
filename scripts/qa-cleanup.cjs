// Usage (inside the api container, where MIGRATION_DATABASE_URL is set):
//   railway ssh --service api --environment staging -- node /app/scripts/qa-cleanup.cjs
// Or paste the queries into the Railway dashboard (Postgres > Data > Query).
// Deletes only QA smoke-test data: users qa-smoke-*@example.com and their qa-smoke-* organisations.
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const users = (await c.query("SELECT id FROM users WHERE email LIKE 'qa-smoke-%@example.com'")).rows.map(r => r.id);
    const orgs = (await c.query("SELECT DISTINCT o.id FROM organisations o JOIN memberships m ON m.organisation_id = o.id WHERE m.user_id = ANY($1::uuid[]) AND o.slug LIKE 'qa-smoke-%'", [users])).rows.map(r => r.id);
    const n = {};
    n.audit = (await c.query('DELETE FROM audit_events WHERE organisation_id = ANY($1::uuid[]) OR actor_id = ANY($2::uuid[])', [orgs, users])).rowCount;
    n.memberships = (await c.query('DELETE FROM memberships WHERE organisation_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])', [orgs, users])).rowCount;
    n.invitations = (await c.query('DELETE FROM invitations WHERE organisation_id = ANY($1::uuid[])', [orgs])).rowCount;
    n.organisations = (await c.query('DELETE FROM organisations WHERE id = ANY($1::uuid[])', [orgs])).rowCount;
    n.users = (await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users])).rowCount;
    await c.query('COMMIT');
    const left = (await c.query("SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM organisations) AS orgs")).rows[0];
    console.log('deleted', JSON.stringify(n), 'remaining', JSON.stringify(left));
  } catch (e) { await c.query('ROLLBACK'); console.error('cleanup failed:', e.message); process.exitCode = 1; }
  finally { await c.end(); }
})();
