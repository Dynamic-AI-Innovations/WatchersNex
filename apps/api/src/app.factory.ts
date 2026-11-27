import 'reflect-metadata';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { AppModule, AppOverrides } from './app.module.js';
import type { AppConfig } from './config/config.js';
import { createLogger } from './common/logger.js';
import { ProblemFilter } from './common/problem.filter.js';
import { resolveRequestId } from './common/request-id.js';

/** Builds the HTTP application. Shared by main.ts and the test suite. */
export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<INestApplication> {
  const logger = createLogger(config.LOG_LEVEL);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger, overrides), {
    logger: false,
    bufferLogs: false,
  });

  app.disable('x-powered-by');
  // Trust exactly the configured number of proxy hops for the client IP used in
  // rate limits and audit (Railway's edge, plus Vercel's rewrite when present).
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = resolveRequestId(req);
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Health probes run every few seconds; logging them adds noise, not signal.
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  return app;
}
