import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEEDS_PASSWORD_KEY } from '../src/common/auth.decorators.js';
import { hashPassword, TEST_ONLY_SCRYPT_PARAMS } from '../src/modules/identity/password.js';
import { deriveKey, sealSecret } from '../src/modules/identity/secret-box.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import { totpCode, totpStep } from '../src/modules/identity/totp.js';
import { createDbTestApp, DB_TEST_AUTH_SECRET } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The password step before a sensitive action (issue #99, docs/plan/06 "One
 * administrator, with a password"), against a real database:
 *
 * - every operation the contract marks `x-needs-password: true` refuses a
 *   token without a fresh confirmation, with `code:
 *   PASSWORD_CONFIRMATION_REQUIRED`, and the code's list of `@NeedsPassword()`
 *   routes is exactly the contract's list;
 * - a right password hands back a token that passes, and is audited;
 * - a wrong password counts towards the same lockout as signing in;
 * - a confirmation is good for five minutes, and a refresh carries it over;
 * - a kiosk session cannot take the step, and never needs to.
 *
 * It makes a company of its own (the shared fixture company is reset by one
 * file only, and must never gain rows that reset does not know about).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const DASHBOARD_ORIGIN = 'http://localhost:5173';
const CODE = 'PASSWORD_CONFIRMATION_REQUIRED';
const PASSWORD = 'a password only these tests know';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe.skipIf(!databaseUrl)('the password step before a sensitive action (e2e)', () => {
  let app: NestExpressApplication;
  let companyId = '';
  let adminId = '';
  let adminEmail = '';
  /** A second administrator, the target of the harmless sensitive action below. */
  let colleague = { id: '', email: '', fullName: '' };
  /** The administrator's token straight from signing in: no confirmation on it yet. */
  let signedIn = '';
  let cookie = '';

  beforeAll(async () => {
    const prisma = openFixtureDb(databaseUrl as string);
    try {
      const company = await prisma.company.create({
        data: { name: `Password step ${randomUUID()}` },
      });
      companyId = company.id;
      const passwordHash = await hashPassword(PASSWORD, TEST_ONLY_SCRYPT_PARAMS);
      const boxKey = deriveKey(DB_TEST_AUTH_SECRET, 'secret-box');
      adminEmail = `admin-${randomUUID()}@pwtest.example`;
      const admin = await prisma.user.create({
        data: {
          companyId,
          email: adminEmail,
          passwordHash,
          fullName: 'Efua Admin',
          role: 'ADMIN',
          twoFactorSecretEncrypted: sealSecret(TOTP_SECRET, boxKey),
          twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      adminId = admin.id;
      const second = await prisma.user.create({
        data: {
          companyId,
          email: `colleague-${randomUUID()}@pwtest.example`,
          passwordHash,
          fullName: 'Ama Admin',
          role: 'ADMIN',
          twoFactorSecretEncrypted: sealSecret(TOTP_SECRET, boxKey),
          twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      colleague = { id: second.id, email: second.email, fullName: second.fullName };
    } finally {
      await prisma.$disconnect();
    }
    app = await createDbTestApp(databaseUrl as string);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email: adminEmail, password: PASSWORD })
      .expect(200);
    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/2fa/verify')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({
        challengeToken: login.body.challengeToken,
        code: totpCode(TOTP_SECRET, totpStep()),
      })
      .expect(200);
    signedIn = verified.body.accessToken;
    cookie = readCookie(verified.headers['set-cookie']);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

  /** The password step, as the dashboard takes it. */
  function confirm(token: string, password = PASSWORD) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/confirm-password')
      .set(...bearer(token))
      .send({ password });
  }

  /** A sensitive action that changes nothing: renaming a colleague to the name they already have. */
  function sensitiveAction(token: string) {
    return request(app.getHttpServer())
      .patch(`/api/v1/users/${colleague.id}`)
      .set(...bearer(token))
      .send({ fullName: colleague.fullName });
  }

  /** A token signed straight by the service, as the other test files do. */
  function sign(
    user: { id: string },
    extra: { onKiosk?: boolean; passwordConfirmedAt?: Date | null },
  ) {
    return app.get(TokensService).signAccessToken({
      userId: user.id,
      companyId,
      role: 'ADMIN',
      employeeId: null,
      onKiosk: extra.onKiosk ?? false,
      passwordConfirmedAt: extra.passwordConfirmedAt ?? null,
    });
  }

  it('refuses every sensitive operation in the contract without a fresh confirmation', async () => {
    const marked = sensitiveOperationsInContract();
    expect(marked.length).toBeGreaterThanOrEqual(19);
    // The code and the contract name the same routes, so neither list can
    // quietly drift: a route guarded in code is documented, and a route
    // documented as sensitive is guarded.
    expect(new Set(routesGuardedInCode(app))).toEqual(new Set(marked));

    for (const route of marked) {
      const [method, path] = route.split(' ') as [string, string];
      const url = `/api/v1${path.replaceAll(/\{[^}]+\}/g, () => randomUUID())}`;
      const send = request(app.getHttpServer());
      const call = (
        method === 'GET'
          ? send.get(url)
          : method === 'PUT'
            ? send.put(url)
            : method === 'PATCH'
              ? send.patch(url)
              : send.post(url)
      )
        .set(...bearer(signedIn))
        .send({});
      const refused = await call;
      expect({ route, status: refused.status, code: refused.body.code }).toEqual({
        route,
        status: 403,
        code: CODE,
      });
      expect(refused.body.title).toBe('Forbidden');
      expect(refused.body.detail).toBe('Confirm with your password to continue.');
    }
  });

  it('accepts a right password, hands back a token that passes, and audits the step', async () => {
    // Straight from signing in: the password was typed, but not confirmed.
    const before = await sensitiveAction(signedIn).expect(403);
    expect(before.body.code).toBe(CODE);

    const confirmed = await confirm(signedIn).expect(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.body).toMatchObject({ expiresInSeconds: 900, confirmedForSeconds: 300 });
    const token = confirmed.body.accessToken as string;
    expect(token).not.toBe(signedIn);

    await sensitiveAction(token).expect(200);
    // One confirmation covers more than one action.
    await sensitiveAction(token).expect(200);

    const prisma = openFixtureDb(databaseUrl as string);
    try {
      const audited = await prisma.auditLog.findFirst({
        where: { action: 'auth.password_confirmed', actorUserId: adminId },
      });
      expect(audited).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('refuses a wrong password as a field problem, and counts it towards the sign-in lockout', async () => {
    // The colleague's own token, so locking them out touches nothing else here.
    const token = await sign(colleague, {});

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await confirm(token, 'not-the-password').expect(400);
      expect(wrong.body.errors).toEqual([
        { path: 'password', message: 'Your password is incorrect.' },
      ]);
    }
    // The fifth wrong answer locks the email, exactly as five wrong sign-ins would...
    await confirm(token, 'not-the-password').expect(400);
    const locked = await confirm(token).expect(429);
    expect(locked.headers['retry-after']).toBeDefined();
    // ...and signing in is locked by the same counter.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email: colleague.email, password: PASSWORD })
      .expect(429);
  });

  it('lets a confirmation expire after five minutes', async () => {
    const aged = (minutesAgo: number) =>
      sign({ id: adminId }, { passwordConfirmedAt: new Date(Date.now() - minutesAgo * 60_000) });

    await sensitiveAction(await aged(4)).expect(200);
    const tooOld = await sensitiveAction(await aged(6)).expect(403);
    expect(tooOld.body.code).toBe(CODE);
  });

  it('carries a fresh confirmation over a refresh, when the old token is sent along', async () => {
    const confirmed = (await confirm(signedIn).expect(200)).body.accessToken as string;

    // The dashboard sends its current token with every request, the refresh too.
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', DASHBOARD_ORIGIN)
      .set('Cookie', cookie)
      .set(...bearer(confirmed))
      .expect(200);
    cookie = readCookie(refreshed.headers['set-cookie']);
    await sensitiveAction(refreshed.body.accessToken).expect(200);

    // Without the old token there is nothing to carry over: the password is asked again.
    const bare = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', DASHBOARD_ORIGIN)
      .set('Cookie', cookie)
      .expect(200);
    cookie = readCookie(bare.headers['set-cookie']);
    const refused = await sensitiveAction(bare.body.accessToken).expect(403);
    expect(refused.body.code).toBe(CODE);
  });

  it('is not open to a kiosk session, whose own sign-in was the password step', async () => {
    const onKiosk = await sign({ id: adminId }, { onKiosk: true });
    const refused = await confirm(onKiosk).expect(403);
    expect(refused.body.code).toBeUndefined();
    expect(refused.body.detail).toBe('This kiosk session can only use the kiosk screens.');

    // The one sensitive operation a kiosk can reach is let through to its own
    // checks without a prompt: an empty body fails validation (400), not the
    // password step (403).
    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set(...bearer(onKiosk))
      .send({})
      .expect(400);
  });
});

function readCookie(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(';')[0] ?? '';
}

/**
 * Every `METHOD /path` the contract marks `x-needs-password: true`, read
 * straight from the YAML: a path line is indented two spaces, a method line
 * four, and an operation's own keys six.
 */
function sensitiveOperationsInContract(): string[] {
  const yaml = readFileSync(
    fileURLToPath(new URL('../../../packages/contracts/openapi.yaml', import.meta.url)),
    'utf8',
  );
  const found: string[] = [];
  let path: string | undefined;
  let method: string | undefined;
  for (const line of yaml.split('\n')) {
    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine) {
      path = pathLine[1];
      method = undefined;
      continue;
    }
    const methodLine = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (methodLine) {
      method = methodLine[1]?.toUpperCase();
      continue;
    }
    if (path && method && /^ {6}x-needs-password: true\s*$/.test(line)) {
      found.push(`${method} ${path}`);
    }
  }
  return found;
}

/** Every `METHOD /path` a controller marks `@NeedsPassword()`, in the contract's spelling. */
function routesGuardedInCode(app: NestExpressApplication): string[] {
  const routes: string[] = [];
  const controllers = [...app.get(ModulesContainer).values()].flatMap((module) => [
    ...module.controllers.values(),
  ]);
  for (const wrapper of controllers) {
    const controller = wrapper.metatype;
    if (typeof controller !== 'function' || !wrapper.instance) {
      continue;
    }
    const prototype = Object.getPrototypeOf(wrapper.instance) as object;
    // 'path' and 'method' are Nest's own metadata keys for @Controller/@Get/@Post...
    const prefix = String(Reflect.getMetadata('path', controller) ?? '');
    const classGuarded = Reflect.getMetadata(NEEDS_PASSWORD_KEY, controller) === true;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') {
        continue;
      }
      const methodPath = Reflect.getMetadata('path', handler) as string | undefined;
      const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
      if (methodPath === undefined || method === undefined) {
        continue;
      }
      if (!classGuarded && Reflect.getMetadata(NEEDS_PASSWORD_KEY, handler) !== true) {
        continue;
      }
      const joined = `/${[prefix, methodPath].filter((part) => part && part !== '/').join('/')}`
        .replaceAll(/\/+/g, '/')
        .replaceAll(/:([A-Za-z]+)/g, '{$1}');
      routes.push(`${RequestMethod[method]} ${joined}`);
    }
  }
  return routes;
}
