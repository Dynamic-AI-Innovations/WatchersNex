import path from 'node:path';
import { runner } from 'node-pg-migrate';
import type { ClientBase } from 'pg';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Applies all pending SQL migrations. Must run as the schema owner. */
export async function migrate(databaseUrl: string, migrationsDir: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
}

/**
 * Creates (or updates) the login role the API connects as (ADR-003).
 *
 * The role is not a superuser, can't bypass row-level security, and inherits
 * only the privileges of `wnx_app`. Its password is supplied by the platform's
 * secret store and is never logged: the statement is assembled by PostgreSQL's
 * own quoting (`format` with %I and %L), not by string concatenation here.
 */
export async function ensureAppLoginRole(
  owner: ClientBase,
  role: string,
  password: string,
): Promise<void> {
  if (!ROLE_NAME.test(role)) {
    throw new Error('ensureAppLoginRole: invalid role name');
  }
  if (password.length < 32) {
    throw new Error('ensureAppLoginRole: password must be at least 32 characters');
  }

  const exists = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  const { rows } = await owner.query<{ stmt: string }>(
    `SELECT format('${verb} ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L', $1::text, $2::text) AS stmt`,
    [role, password],
  );
  await owner.query(rows[0]!.stmt);

  const grants = await owner.query<{ stmt: string }>(
    `SELECT format('GRANT wnx_app TO %I', $1::text) AS stmt
     UNION ALL
     SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text)`,
    [role],
  );
  for (const { stmt } of grants.rows) {
    await owner.query(stmt);
  }
}

export const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'migrations');
