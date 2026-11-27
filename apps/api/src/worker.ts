import { createLogger } from './common/logger.js';
import { loadConfig } from './config/config.js';
import { createDb } from './db/database.js';
import { LogEmailSender } from './email/email.js';
import { PostmarkEmailSender } from './email/postmark.js';
import { MonitoringEngine } from './monitoring/engine.js';

/**
 * Check worker: a separate process from the API (ADR-001), so check load can
 * never slow user-facing requests. Run several for more capacity: claiming is
 * atomic, so no check runs twice.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ component: 'worker' });
  const { db } = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const email =
    config.EMAIL_TRANSPORT === 'postmark'
      ? new PostmarkEmailSender(config.POSTMARK_SERVER_TOKEN as string, config.EMAIL_FROM)
      : new LogEmailSender(logger, config.EMAIL_LOG_LINKS);
  const engine = new MonitoringEngine({ db, logger, email, region: config.PROBE_REGION, appBaseUrl: config.APP_BASE_URL });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await engine.maintainPartitions();
  let lastMaintenance = Date.now();
  logger.info({ region: config.PROBE_REGION }, 'worker started');

  while (!stopping) {
    try {
      const processed = await engine.tick();
      if (Date.now() - lastMaintenance > 60 * 60 * 1000) {
        await engine.maintainPartitions();
        lastMaintenance = Date.now();
      }
      if (processed === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      logger.error({ err: error }, 'worker tick failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  logger.info('worker stopping');
  await db.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
