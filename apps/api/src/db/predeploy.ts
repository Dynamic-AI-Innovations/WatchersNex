import { Client } from 'pg';
import { ensureAppLoginRole, migrate, MIGRATIONS_DIR } from './provision.js';

/**
 * Runs once before each deployment goes live (Railway pre-deploy command).
 * Uses the owner connection only here; the running API never gets it.
 */
async function main(): Promise<void> {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const role = process.env.APP_DB_ROLE ?? 'wnx_api';
  const password = process.env.APP_DB_PASSWORD;
  if (!ownerUrl || !password) {
    throw new Error('predeploy: MIGRATION_DATABASE_URL and APP_DB_PASSWORD are required');
  }

  await migrate(ownerUrl, MIGRATIONS_DIR);
  console.log('predeploy: migrations applied');

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await ensureAppLoginRole(client, role, password);
    console.log(`predeploy: login role ${role} ready`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('predeploy failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
