import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp } from './app.setup.js';
import { AppConfig } from './config/app-config.js';
import { loadEnvFile } from './config/env.js';

/**
 * Starts the API. Run it with `pnpm dev:api` from the repository root.
 *
 * Note on imports: this project uses modern ES modules, so relative imports
 * name the compiled file (`./app.module.js`) even though you edit `.ts` files.
 */
async function bootstrap(): Promise<void> {
  loadEnvFile();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Keep each JSON body's exact bytes too: device signatures are checked over them.
    rawBody: true,
    // JSON logs in production are easier for hosting platforms to search.
    logger: new ConsoleLogger({ json: process.env.NODE_ENV === 'production' }),
  });
  const config = app.get(AppConfig);
  configureApp(app, config);

  await app.listen(config.port);
  Logger.log(`API ready at http://localhost:${config.port}${API_PREFIX}/health`, 'Bootstrap');
}

await bootstrap();
