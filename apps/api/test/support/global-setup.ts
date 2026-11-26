import { rmSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { runner } from 'node-pg-migrate';
import type { TestProject } from 'vitest/node';

const PORT = 54329;
const API_ROOT = path.join(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(API_ROOT, '.pgdata');

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Tests run against a real PostgreSQL, never a mock, because tenant isolation
 * is enforced by the database itself. CI provides TEST_DATABASE_URL (a
 * PostgreSQL service container); locally an embedded PostgreSQL 18 is started.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let pg: EmbeddedPostgres | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      user: 'postgres',
      password: 'postgres',
      port: PORT,
      persistent: false,
      onLog: () => undefined,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('wnx_test');
    databaseUrl = `postgres://postgres:postgres@localhost:${PORT}/wnx_test`;
  }

  await runner({
    databaseUrl,
    dir: path.join(API_ROOT, 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await pg?.stop();
  };
}
