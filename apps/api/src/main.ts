import { createApp } from './app.factory.js';
import { loadConfig } from './config/config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  // Configuration errors name variables only, never their values.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
