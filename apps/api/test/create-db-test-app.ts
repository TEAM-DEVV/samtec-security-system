import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppConfig } from '../src/config/app-config.js';

/** The AUTH_SECRET the database-backed tests run with. Test-only. */
export const DB_TEST_AUTH_SECRET = 'db-test-auth-secret-at-least-32-chars!!!';

/**
 * Starts the real application against a real PostgreSQL database — nothing is
 * faked. Used by `test/db.e2e-spec.ts`; see that file for how to run it.
 */
export async function createDbTestApp(databaseUrl: string): Promise<NestExpressApplication> {
  const config = new AppConfig({
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: databaseUrl,
    CORS_ORIGINS: ['http://localhost:5173'],
    AUTH_SECRET: DB_TEST_AUTH_SECRET,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app, config);
  await app.init();
  return app;
}
