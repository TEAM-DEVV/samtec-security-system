import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { requestIdMiddleware } from './common/request-id.middleware.js';
import type { AppConfig } from './config/app-config.js';

/**
 * Every route starts with this prefix, for example `/api/v1/health`.
 *
 * Keep the leading slash. NestJS 12 attaches its "route not found" handler to
 * this exact value, and without the slash an unknown route would answer with
 * an HTML page instead of a Problem Details error. The e2e test checks this.
 */
export const API_PREFIX = '/api/v1';

/**
 * Applies the settings every copy of the app needs. Both `main.ts` and the
 * end-to-end tests call this, so tests run with the same security settings as
 * production.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.setGlobalPrefix(API_PREFIX);
  app.use(requestIdMiddleware);
  // Secure HTTP headers, e.g. stops browsers from guessing content types and
  // hides which framework the API runs on.
  app.use(helmet());
  // Only the dashboard and the kiosk app may call the API from a browser.
  // `exposedHeaders` lists the response headers they may read.
  app.enableCors({
    origin: [...config.corsOrigins, ...config.kioskOrigins],
    credentials: true,
    exposedHeaders: ['Location', 'Retry-After', 'X-Request-ID'],
  });
  // Read JSON bodies up to 100 kB. A bigger body is refused with 413 before
  // any of our code runs. Endpoints that need more (such as device punch
  // batches in Phase 2) must say so in the contract and be reviewed.
  app.useBodyParser('json', { limit: '100kb' });
  // Validates any request body, query or route parameter that declares a Zod `schema`.
  // The custom exceptionFactory keeps each problem's field path, so the error
  // response can tell the dashboard exactly which field is wrong.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new BadRequestException({
          message: issues.map((issue) => ({ path: issue.path ?? [], message: issue.message })),
        }),
    }),
  );
  // Close the database connection cleanly when the process stops.
  app.enableShutdownHooks();
}
