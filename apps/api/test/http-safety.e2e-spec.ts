import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Public } from '../src/common/auth.decorators.js';
import { createTestApp } from './create-test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const probeSchema = z.strictObject({
  name: z.string().min(1, 'Required.'),
  phone: z.string().regex(/^\+233\d{9}$/, 'Must look like +233241234567.'),
});

/**
 * A route that exists only in this test, so the real validation pipe can be
 * tried. `@Public()` because these tests are about validation, not sign-in.
 */
@Public()
@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  @HttpCode(200)
  accept(@Body({ schema: probeSchema }) body: z.infer<typeof probeSchema>) {
    return body;
  }
}

/**
 * The protections every endpoint gets for free: request IDs, validation
 * errors, body limits and safe error messages.
 */
describe('HTTP safety (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ValidationProbeController] });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('request IDs', () => {
    it('keeps a safe request ID sent by the caller', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-ID', 'trace-12345678');

      expect(response.headers['x-request-id']).toBe('trace-12345678');
    });

    it('replaces an unsafe request ID with a new one', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-ID', 'bad id!');

      expect(response.headers['x-request-id']).toMatch(UUID);
    });
  });

  describe('validation', () => {
    it('accepts a valid body', async () => {
      const body = { name: 'Kwame Mensah', phone: '+233241234567' };

      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .send(body)
        .expect(200);

      expect(response.body).toEqual(body);
    });

    it('lists every invalid field', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .send({ name: '', phone: '0241234567' })
        .expect(400);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.type).toBe('urn:samtec:problem:validation-error');
      expect(response.body.errors).toEqual([
        { path: 'name', message: 'Required.' },
        { path: 'phone', message: 'Must look like +233241234567.' },
      ]);
    });

    it('rejects fields the schema does not know', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .send({ name: 'Kwame Mensah', phone: '+233241234567', role: 'ADMIN' })
        .expect(400);

      expect(response.body.type).toBe('urn:samtec:problem:validation-error');
    });
  });

  describe('request bodies', () => {
    it('refuses a body larger than 100 kB with 413', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'x'.repeat(200_000), phone: '+233241234567' }))
        .expect(413);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({
        status: 413,
        detail: 'The request body is too large.',
      });
    });

    it('refuses a character set other than UTF-8 with 415', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .set('Content-Type', 'application/json; charset=latin1')
        .send('{}')
        .expect(415);

      expect(response.body.status).toBe(415);
    });

    it('answers broken JSON with a 400 Problem Details error', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/validation-probe')
        .set('Content-Type', 'application/json')
        .send('{"name": ')
        .expect(400);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.traceId).toBe(response.headers['x-request-id']);
    });
  });

  describe('error messages', () => {
    it('never repeats the query string, which can hold search terms', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/does-not-exist?search=Kwame')
        .expect(404);

      expect(response.body.instance).toBe('/api/v1/does-not-exist');
      expect(JSON.stringify(response.body)).not.toContain('Kwame');
    });
  });
});
