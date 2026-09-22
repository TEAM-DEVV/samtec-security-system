import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppConfig } from '../src/config/app-config.js';
import type { Env } from '../src/config/env.js';

/** The AUTH_SECRET the database-backed tests run with. Test-only. */
export const DB_TEST_AUTH_SECRET = 'db-test-auth-secret-at-least-32-chars!!!';

/**
 * Starts the real application against a real PostgreSQL database — nothing is
 * faked. Used by `test/db.e2e-spec.ts`; see that file for how to run it.
 * `settings` changes a setting for one test, such as running in production
 * mode or switching simulator devices off.
 */
export async function createDbTestApp(
  databaseUrl: string,
  settings: Pick<Partial<Env>, 'ALLOW_SIMULATOR_DEVICES' | 'NODE_ENV'> = {},
): Promise<NestExpressApplication> {
  const config = new AppConfig({
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: databaseUrl,
    CORS_ORIGINS: ['http://localhost:5173'],
    AUTH_SECRET: DB_TEST_AUTH_SECRET,
    ...settings,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app, config);
  // Listen once, on a free local port. Otherwise supertest starts and stops
  // the same server around every request, and requests sent in parallel can
  // cut each other off (ECONNRESET).
  await app.listen(0, '127.0.0.1');
  return app;
}
