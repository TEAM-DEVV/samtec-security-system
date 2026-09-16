import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './create-test-app.js';

/**
 * End-to-end test: starts the real Nest application and sends real HTTP
 * requests to it. See `create-test-app.ts` for how the database is faked.
 */
describe('Health endpoint (e2e)', () => {
  describe('when the database answers', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      app = await createTestApp({ databaseUp: true });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 200 and only the fields the contract allows', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        time: expect.any(String),
        checks: { database: 'up' },
      });
    });

    it('sends security headers and a request ID', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers unknown routes with a Problem Details 404', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        instance: '/api/v1/does-not-exist',
      });
      expect(response.body.traceId).toBe(response.headers['x-request-id']);
    });
  });

  describe('when the database is down', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      app = await createTestApp({ databaseUp: false });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 503 with a degraded report', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(503);

      expect(response.body.status).toBe('degraded');
      expect(response.body.checks.database).toBe('down');
    });
  });
});
