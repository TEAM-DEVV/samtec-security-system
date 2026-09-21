import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/database/prisma.service.js';

interface TestAppOptions {
  /** What the pretend database answers to the health check. Defaults to true. */
  databaseUp?: boolean;
  /** Extra controllers that exist only in a test, for example to try the validation pipe. */
  controllers?: Type[];
}

/**
 * Starts the real application for an end-to-end test, with the same security
 * settings as production. The database is replaced by a fake, so these tests
 * run anywhere, including CI, without PostgreSQL.
 *
 * Remember to call `await app.close()` when the tests finish.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const config = new AppConfig({
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgresql://samtec@localhost:5432/samtec_test',
    CORS_ORIGINS: ['http://localhost:5173'],
    AUTH_SECRET: 'test-only-auth-secret-at-least-32-chars!',
  });
  const databaseUp = options.databaseUp ?? true;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(PrismaService)
    .useValue({ isReachable: async () => databaseUp, $disconnect: async () => undefined })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app, config);
  // Listen once, on a free local port. Otherwise supertest starts and stops
  // the same server around every request, and requests sent in parallel can
  // cut each other off (ECONNRESET).
  await app.listen(0, '127.0.0.1');
  return app;
}
