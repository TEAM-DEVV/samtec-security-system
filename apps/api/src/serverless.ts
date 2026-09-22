import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { AppConfig } from './config/app-config.js';

/**
 * The API for serverless hosting (Vercel), used by `api/index.ts`.
 *
 * Locally the API is one long-running process (`src/main.ts`). On Vercel it
 * runs as a function instead: the platform starts it for a request and may
 * freeze or discard it afterwards. So instead of `listen()`ing on a port, we
 * build the same fully-configured app and hand back its request handler.
 * Everything else — security settings, guards, validation, error format — is
 * identical, because both entry points call the same `configureApp`.
 */
export async function createApiHandler(): Promise<Express> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Keep each JSON body's exact bytes too: device signatures are checked over them.
    rawBody: true,
    logger: new ConsoleLogger({ json: true }),
  });
  configureApp(app, app.get(AppConfig));
  await app.init();
  return app.getHttpAdapter().getInstance() as Express;
}
