import { Generated, Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool } from 'pg';

/** Table types, added module by module as migrations land. */
export interface Database {
  users: {
    id: string;
    email: string;
    name: string;
    password_hash: string;
    email_verified_at: Date | null;
    status: Generated<'active' | 'locked' | 'deleted'>;
    is_platform_admin: Generated<boolean>;
    failed_login_count: Generated<number>;
    locked_until: Date | null;
    password_changed_at: Generated<Date>;
    created_at: Generated<Date>;
  };
  sessions: {
    id: string;
    user_id: string;
    token_hash: Buffer;
    mfa_verified: Generated<boolean>;
    ip: string | null;
    user_agent: string | null;
    created_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    expires_at: Date;
    revoked_at: Date | null;
  };
  verification_tokens: {
    id: string;
    user_id: string;
    purpose: 'verify_email' | 'reset_password';
    token_hash: Buffer;
    expires_at: Date;
    used_at: Date | null;
  };
  organisations: {
    id: string;
    name: string;
    slug: string;
    timezone: Generated<string>;
    plan_id: string;
    status: Generated<string>;
    created_at: Generated<Date>;
  };
  memberships: {
    organisation_id: string;
    user_id: string;
    role: 'owner' | 'admin' | 'operator' | 'viewer';
    created_at: Generated<Date>;
  };
  audit_events: {
    id: string;
    organisation_id: string | null;
    actor_id: string | null;
    actor_type: 'user' | 'platform_admin' | 'system' | 'probe';
    action: string;
    resource_type: string;
    resource_id: string | null;
    ip: string | null;
    metadata: Generated<unknown>;
  };
}

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** @deprecated use Tx */
export type TenantTx = Tx;

/** The non-privileged role every application transaction runs as. Created by migration 0001. */
export const APP_ROLE = 'wnx_app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function createDb(connectionString: string, max = 10): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString, max });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/**
 * Run `work` as the application role with no organisation selected: for
 * account-level work (sign-up, login, sessions) that happens before a tenant
 * is chosen. Tenant tables return no rows in this mode.
 */
export async function withAppRole<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`.execute(tx);
    return work(tx);
  });
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
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(organisationId)) {
    throw new Error('withTenant: organisationId must be a UUID');
  }
  return db.transaction().execute(async (tx) => {
    await sql`SET LOCAL ROLE ${sql.raw(APP_ROLE)}`.execute(tx);
    await sql`SELECT set_config('app.current_org', ${organisationId}, true)`.execute(tx);
    return work(tx);
  });
}

/** True when a PostgreSQL error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
