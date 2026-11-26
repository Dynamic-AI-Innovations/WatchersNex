import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool } from 'pg';

/**
 * Table types are added module by module as migrations land. Kept deliberately
 * small until the identity and tenancy modules are built.
 */
export interface Database {
  organisations: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    plan_id: string;
    status: string;
  };
  memberships: {
    organisation_id: string;
    user_id: string;
    role: 'owner' | 'admin' | 'operator' | 'viewer';
  };
}

export type Db = Kysely<Database>;
export type TenantTx = Transaction<Database>;

/** The non-privileged role every tenant transaction runs as. Created by migration 0001. */
export const APP_ROLE = 'wnx_app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(connectionString: string, max = 10): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString, max });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/**
 * Run `work` inside a transaction scoped to one organisation.
 *
 * Two independent guards make row-level security apply (ADR-003):
 * 1. `SET LOCAL ROLE wnx_app` drops to the non-privileged role, so RLS applies
 *    even if the connection itself is a superuser or the table owner.
 * 2. `app.current_org` is set for this transaction only; every tenant table's
 *    policy compares against it, and an unset value matches no rows.
 */
export async function withTenant<T>(
  db: Db,
  organisationId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organisationId)) {
    throw new Error('withTenant: organisationId must be a UUID');
  }
  return db.transaction().execute(async (tx) => {
    await sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`.execute(tx);
    await sql`SELECT set_config('app.current_org', ${organisationId}, true)`.execute(tx);
    return work(tx);
  });
}
