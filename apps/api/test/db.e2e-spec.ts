import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode, totpStep } from '../src/modules/identity/totp.js';
import { createDbTestApp } from './create-db-test-app.js';
import {
  ADMIN_TOTP_SECRET,
  EMAILS,
  GUARD_EMPLOYEE_ID,
  OTHER_SITE_EMPLOYEE_ID,
  openFixtureDb,
  resetFixture,
  SITE_1_ID,
  SITE_2_ID,
  TERMINATED_EMPLOYEE_ID,
  TEST_PASSWORD,
} from './db-fixture.js';

/**
 * The whole Phase 1 backend against a **real PostgreSQL database** — nothing
 * faked. These run when TEST_DATABASE_URL points at a migrated database:
 *
 * - Locally: start the database (`pnpm db:start`), then
 *   `TEST_DATABASE_URL=postgresql://samtec:samtec-local-only@localhost:54329/samtec_dev pnpm --filter @samtec/api test`
 * - In CI: the `database` job runs them against its PostgreSQL service.
 *
 * Without TEST_DATABASE_URL the file is skipped, so `pnpm test` works anywhere.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';

describe.skipIf(!databaseUrl)('Phase 1 on a real database (e2e)', () => {
  let app: NestExpressApplication;
  // HR's token appears later: the two-factor walkthrough test signs them in.
  const tokens = { admin: '', supervisor: '', guard: '' };

  beforeAll(async () => {
    const prisma = openFixtureDb(databaseUrl as string);
    await resetFixture(prisma);
    await prisma.$disconnect();
    app = await createDbTestApp(databaseUrl as string);

    // Sign everyone in once; the tests below use these access tokens.
    tokens.supervisor = await passwordSignIn(EMAILS.supervisor);
    tokens.guard = await passwordSignIn(EMAILS.guard);
    tokens.admin = await twoFactorSignIn();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  /** Signs in an account that has no two-factor step and returns its access token. */
  async function passwordSignIn(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    expect(response.body.status).toBe('AUTHENTICATED');
    return response.body.accessToken;
  }

  /** Signs the admin in: password first, then a real code from the known secret. */
  async function twoFactorSignIn(): Promise<string> {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAILS.admin, password: TEST_PASSWORD })
      .expect(200);
    expect(login.body.status).toBe('TWO_FACTOR_REQUIRED');

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/2fa/verify')
      .send({
        challengeToken: login.body.challengeToken,
        code: totpCode(ADMIN_TOTP_SECRET, totpStep()),
      })
      .expect(200);
    return verified.body.accessToken;
  }

  function bearer(token: string): [string, string] {
    return ['Authorization', `Bearer ${token}`];
  }

  describe('signing in', () => {
    it('refuses an unknown email with the same message as a wrong password', async () => {
      const unknown = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@dbtest.example', password: TEST_PASSWORD })
        .expect(401);
      const wrong = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: EMAILS.hr, password: 'wrong-password' })
        .expect(401);

      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('sets the refresh cookie with the attributes the contract promises', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: EMAILS.guard, password: TEST_PASSWORD })
        .expect(200);

      const cookie = readSetCookie(response.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api/v1/auth');
    });

    it('locks an email for 15 minutes after five wrong passwords — account or not', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'lock-me@dbtest.example', password: 'guess' })
          .expect(401);
      }

      const locked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'lock-me@dbtest.example', password: 'guess' })
        .expect(429);

      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(locked.body.detail).toContain('Try again in');
    });

    it('walks HR through two-factor setup, and requires the code from then on', async () => {
      // 1. Password is right, but this role must set up two-factor first.
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: EMAILS.hr, password: TEST_PASSWORD })
        .expect(200);
      expect(login.body.status).toBe('TWO_FACTOR_SETUP_REQUIRED');

      // 2. Get the QR code (as its otpauth link and manual key).
      const setup = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/setup')
        .send({ setupToken: login.body.setupToken })
        .expect(200);
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/SAMTEC:/);
      const secret = setup.body.manualEntryKey;

      // 3. A wrong first code does not enable anything.
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/enable')
        .send({ setupToken: login.body.setupToken, code: '000000' })
        .expect(401);

      // 4. The right code proves the app works: two-factor is on, user signed in.
      const usedStep = totpStep();
      const enabled = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/enable')
        .send({ setupToken: login.body.setupToken, code: totpCode(secret, usedStep) })
        .expect(200);
      expect(enabled.body.user.twoFactorEnabled).toBe(true);

      // 5. Signing in again now asks for a code…
      const nextLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: EMAILS.hr, password: TEST_PASSWORD })
        .expect(200);
      expect(nextLogin.body.status).toBe('TWO_FACTOR_REQUIRED');

      // 6. …and the code that was already used is refused (replay protection)…
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/verify')
        .send({ challengeToken: nextLogin.body.challengeToken, code: totpCode(secret, usedStep) })
        .expect(401);

      // 7. …while the next step's code signs them in.
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/verify')
        .send({
          challengeToken: nextLogin.body.challengeToken,
          code: totpCode(secret, usedStep + 1),
        })
        .expect(200);
    }, 30_000);

    it('tells the signed-in user who they are, and strangers nothing', async () => {
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(tokens.guard))
        .expect(200);
      expect(me.body.email).toBe(EMAILS.guard);
      expect(me.body.employeeId).toBe(GUARD_EMPLOYEE_ID);

      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('refresh tokens', () => {
    async function signInAndGetCookie(): Promise<string> {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: EMAILS.supervisor, password: TEST_PASSWORD })
        .expect(200);
      return readSetCookie(response.headers['set-cookie']).split(';')[0] ?? '';
    }

    it('rotates on every refresh, and a replayed cookie signs everyone out', async () => {
      const firstCookie = await signInAndGetCookie();

      const refreshed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', firstCookie)
        .expect(200);
      expect(refreshed.body.expiresInSeconds).toBe(900);
      const secondCookie = readSetCookie(refreshed.headers['set-cookie']).split(';')[0] ?? '';
      expect(secondCookie).not.toBe(firstCookie);

      // The first cookie again: reuse detected…
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', firstCookie)
        .expect(401);

      // …so even the newest cookie is now dead.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', secondCookie)
        .expect(401);
    });

    it('refuses refresh and logout from an unknown Origin', async () => {
      const cookie = await signInAndGetCookie();

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookie)
        .expect(403);
      await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(403);
    });

    it('signs out: the revoked cookie can never refresh again', async () => {
      const cookie = await signInAndGetCookie();

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .expect(204);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .expect(401);
    });
  });

  describe('employees', () => {
    it('pages through the list in staff number order, without identity fields', async () => {
      const firstPage = await request(app.getHttpServer())
        .get('/api/v1/employees?limit=2')
        .set(...bearer(tokens.admin))
        .expect(200);

      expect(firstPage.body.items.map((item: { staffNumber: string }) => item.staffNumber)).toEqual(
        ['SMT-90001', 'SMT-90002'],
      );
      expect(firstPage.body.items[0]).not.toHaveProperty('ghanaCardNumber');
      expect(firstPage.body.items[0]).not.toHaveProperty('phone');
      expect(firstPage.body.nextCursor).not.toBeNull();

      const secondPage = await request(app.getHttpServer())
        .get(`/api/v1/employees?limit=2&cursor=${firstPage.body.nextCursor}`)
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(
        secondPage.body.items.map((item: { staffNumber: string }) => item.staffNumber),
      ).toEqual(['SMT-90003', 'SMT-90004']);
      expect(secondPage.body.nextCursor).toBeNull();
    });

    it('filters by status and searches by name, case-insensitively', async () => {
      const terminated = await request(app.getHttpServer())
        .get('/api/v1/employees?status=TERMINATED')
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(terminated.body.items).toHaveLength(1);
      expect(terminated.body.items[0].staffNumber).toBe('SMT-90004');

      const search = await request(app.getHttpServer())
        .get('/api/v1/employees?search=adjei')
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(search.body.items).toHaveLength(1);
      expect(search.body.items[0].fullName).toBe('Kojo Adjei');
    });

    it('shows a supervisor only the employees on their own sites', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/employees')
        .set(...bearer(tokens.supervisor))
        .expect(200);

      expect(
        response.body.items.map((item: { staffNumber: string }) => item.staffNumber).sort(),
      ).toEqual(['SMT-90001', 'SMT-90002']);

      // An employee on another site "does not exist" for them.
      await request(app.getHttpServer())
        .get(`/api/v1/employees/${OTHER_SITE_EMPLOYEE_ID}`)
        .set(...bearer(tokens.supervisor))
        .expect(404);
    });

    it('lets a guard read only their own record — with their Ghana Card number', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/employees')
        .set(...bearer(tokens.guard))
        .expect(403);

      const own = await request(app.getHttpServer())
        .get(`/api/v1/employees/${GUARD_EMPLOYEE_ID}`)
        .set(...bearer(tokens.guard))
        .expect(200);
      expect(own.body.ghanaCardNumber).toMatch(/^GHA-\d{9}-\d$/);

      await request(app.getHttpServer())
        .get(`/api/v1/employees/${OTHER_SITE_EMPLOYEE_ID}`)
        .set(...bearer(tokens.guard))
        .expect(404);
    });

    it('hides the Ghana Card number from a supervisor reading someone else', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/employees/${GUARD_EMPLOYEE_ID}`)
        .set(...bearer(tokens.supervisor))
        .expect(200);

      expect(response.body.fullName).toBe('Kwame Mensah');
      expect(response.body).not.toHaveProperty('ghanaCardNumber');
    });

    it('rejects a made-up cursor and an oversized limit with clear 400s', async () => {
      const badCursor = await request(app.getHttpServer())
        .get('/api/v1/employees?cursor=!!!not-a-cursor!!!')
        .set(...bearer(tokens.admin))
        .expect(400);
      expect(badCursor.body.errors[0].path).toBe('cursor');

      const badLimit = await request(app.getHttpServer())
        .get('/api/v1/employees?limit=101')
        .set(...bearer(tokens.admin))
        .expect(400);
      expect(badLimit.body.errors[0].path).toBe('limit');
    });

    it('requires sign-in', async () => {
      await request(app.getHttpServer()).get('/api/v1/employees').expect(401);
    });
  });

  describe('sites', () => {
    it('lists sites with live guard counts for HR', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sites')
        .set(...bearer(tokens.admin))
        .expect(200);

      const byCode = new Map(
        response.body.items.map((item: { code: string; activeGuardCount: number }) => [
          item.code,
          item.activeGuardCount,
        ]),
      );
      expect(byCode.get('TSA-01')).toBe(2); // Supervisor + guard, both ACTIVE.
      expect(byCode.get('TSB-01')).toBe(1);
    });

    it('shows a supervisor only their own site, and a guard none at all', async () => {
      const supervisorList = await request(app.getHttpServer())
        .get('/api/v1/sites')
        .set(...bearer(tokens.supervisor))
        .expect(200);
      expect(supervisorList.body.items.map((item: { code: string }) => item.code)).toEqual([
        'TSA-01',
      ]);

      await request(app.getHttpServer())
        .get(`/api/v1/sites/${SITE_2_ID}`)
        .set(...bearer(tokens.supervisor))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/sites/${SITE_1_ID}`)
        .set(...bearer(tokens.guard))
        .expect(404);
    });
  });

  describe('employee writes', () => {
    const newEmployee = {
      firstName: 'Adjoa',
      lastName: 'Sarpong',
      phone: '+233209999901',
      ghanaCardNumber: 'GHA-955555000-5',
      position: 'Security Guard',
      hireDate: '2026-09-01',
    };

    it('creates an employee: 201, Location header, generated staff number, audit row', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.admin))
        .send({ ...newEmployee, siteId: SITE_1_ID })
        .expect(201);

      expect(response.headers.location).toBe(`/api/v1/employees/${response.body.id}`);
      expect(response.body.staffNumber).toBe('SMT-90005'); // After the fixture's SMT-90004.
      expect(response.body.status).toBe('PENDING_ENROLLMENT');
      expect(response.body.ghanaCardNumber).toBe(newEmployee.ghanaCardNumber);
      expect(response.body.currentSite.id).toBe(SITE_1_ID);

      const prisma = openFixtureDb(databaseUrl as string);
      const periods = await prisma.employmentPeriod.findMany({
        where: { employeeId: response.body.id },
      });
      const auditRows = await prisma.auditLog.findMany({
        where: { action: 'employee.created', entityId: response.body.id },
      });
      await prisma.$disconnect();

      expect(periods).toHaveLength(1);
      expect(periods[0]?.endsOn).toBeNull();
      expect(auditRows).toHaveLength(1);
      // The audit row names the record, never the person's details.
      expect(JSON.stringify(auditRows[0]?.detail)).not.toContain('Sarpong');
    });

    it('refuses a second employee with the same Ghana Card number (409)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.admin))
        .send({ ...newEmployee, phone: '+233209999902' })
        .expect(409);
      expect(response.body.detail).toContain('Ghana Card');
    });

    it('refuses a site that does not exist, and callers below HR', async () => {
      const badSite = await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.admin))
        .send({
          ...newEmployee,
          ghanaCardNumber: 'GHA-955555001-6',
          siteId: '01927c3e-0000-7000-8000-00000000dead',
        })
        .expect(400);
      expect(badSite.body.errors[0].path).toBe('siteId');

      await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.supervisor))
        .send(newEmployee)
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.guard))
        .send(newEmployee)
        .expect(403);
    });

    it('updates details and moves the posting to another site', async () => {
      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${GUARD_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ position: 'Senior Guard', siteId: SITE_2_ID })
        .expect(200);

      expect(updated.body.position).toBe('Senior Guard');
      expect(updated.body.currentSite.id).toBe(SITE_2_ID);

      const prisma = openFixtureDb(databaseUrl as string);
      const openAssignments = await prisma.siteAssignment.findMany({
        where: { employeeId: GUARD_EMPLOYEE_ID, endsOn: null },
      });
      await prisma.$disconnect();
      // Exactly one open posting: the old one at site 1 was closed.
      expect(openAssignments).toHaveLength(1);
      expect(openAssignments[0]?.siteId).toBe(SITE_2_ID);
    });

    it('never lets the Ghana Card number change through an update', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${GUARD_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ ghanaCardNumber: 'GHA-000000000-0' })
        .expect(400);
      expect(JSON.stringify(response.body.errors)).toContain('ghanaCardNumber');
    });

    it('refuses to change someone who has already left (409)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/employees/${TERMINATED_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ position: 'Ghost' })
        .expect(409);
    });

    it('terminates: status, dates, posting and period all close together', async () => {
      const before = await request(app.getHttpServer())
        .post(`/api/v1/employees/${OTHER_SITE_EMPLOYEE_ID}/terminate`)
        .set(...bearer(tokens.admin))
        .send({ effectiveDate: '2025-01-01', reason: 'RESIGNED' })
        .expect(400); // Before the hire date.
      expect(before.body.errors[0].path).toBe('effectiveDate');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/employees/${OTHER_SITE_EMPLOYEE_ID}/terminate`)
        .set(...bearer(tokens.admin))
        .send({ effectiveDate: '2026-09-30', reason: 'RESIGNED', note: 'Moving away.' })
        .expect(200);
      expect(response.body.status).toBe('TERMINATED');
      expect(response.body.terminationDate).toBe('2026-09-30');

      const prisma = openFixtureDb(databaseUrl as string);
      const openPostings = await prisma.siteAssignment.count({
        where: { employeeId: OTHER_SITE_EMPLOYEE_ID, endsOn: null },
      });
      const openPeriods = await prisma.employmentPeriod.count({
        where: { employeeId: OTHER_SITE_EMPLOYEE_ID, endsOn: null },
      });
      const auditRows = await prisma.auditLog.findMany({
        where: { action: 'employee.terminated', entityId: OTHER_SITE_EMPLOYEE_ID },
      });
      await prisma.$disconnect();

      expect(openPostings).toBe(0);
      expect(openPeriods).toBe(0);
      // The reason is audited; the free-text note never is.
      expect(JSON.stringify(auditRows.at(-1)?.detail)).toContain('RESIGNED');
      expect(JSON.stringify(auditRows.at(-1)?.detail)).not.toContain('Moving away');

      // Terminating twice is a clear conflict.
      await request(app.getHttpServer())
        .post(`/api/v1/employees/${OTHER_SITE_EMPLOYEE_ID}/terminate`)
        .set(...bearer(tokens.admin))
        .send({ effectiveDate: '2026-10-01', reason: 'RESIGNED' })
        .expect(409);
    });

    it('requires a note when the reason is OTHER', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/employees/${GUARD_EMPLOYEE_ID}/terminate`)
        .set(...bearer(tokens.admin))
        .send({ effectiveDate: '2026-09-30', reason: 'OTHER' })
        .expect(400);
      expect(response.body.errors[0].path).toBe('note');
    });
  });

  describe('sign-in throttle (atomic counting)', () => {
    function wrongLogin(email: string) {
      return request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-guess' });
    }

    it('counts PARALLEL wrong passwords — a burst cannot slip past the lockout', async () => {
      // The attack: fire many guesses at once, hoping each one reads the
      // counter before any writes it. The atomic SQL counts them all.
      const burst = await Promise.all(
        Array.from({ length: 8 }, () => wrongLogin('burst@dbtest.example')),
      );
      // At least the first responses are 401; once the count passes 5 the rest are 429.
      expect(burst.every((r) => r.status === 401 || r.status === 429)).toBe(true);

      const after = await wrongLogin('burst@dbtest.example');
      expect(after.status).toBe(429);
      expect(Number(after.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('stores only keyed hashes — never the emails people typed', async () => {
      await wrongLogin('privacy-probe@dbtest.example');

      const prisma = openFixtureDb(databaseUrl as string);
      const rows = await prisma.signInThrottle.findMany();
      await prisma.$disconnect();

      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain('dbtest.example');
      for (const row of rows) {
        expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('forgets failures once the 15-minute window has passed', async () => {
      // Four failures, then move the window back in time by hand.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await wrongLogin('window@dbtest.example').expect(401);
      }
      const prisma = openFixtureDb(databaseUrl as string);
      await prisma.signInThrottle.updateMany({
        data: { windowStartsAt: new Date(Date.now() - 16 * 60_000) },
      });
      await prisma.$disconnect();

      // The 5th failure lands in a fresh window: counted as the 1st, no lock.
      await wrongLogin('window@dbtest.example').expect(401);
      await wrongLogin('window@dbtest.example').expect(401);
    });
  });

  describe('system info', () => {
    it('is for administrators only', async () => {
      const asAdmin = await request(app.getHttpServer())
        .get('/api/v1/system/info')
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(asAdmin.body.environment).toBe('test');
      expect(asAdmin.body.uptimeSeconds).toBeGreaterThanOrEqual(0);

      await request(app.getHttpServer())
        .get('/api/v1/system/info')
        .set(...bearer(tokens.supervisor))
        .expect(403);
      await request(app.getHttpServer()).get('/api/v1/system/info').expect(401);
    });
  });
});

/** The `samtec_refresh` Set-Cookie line from a response. */
function readSetCookie(header: string | string[] | undefined): string {
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  const line = lines.find((candidate) => candidate.startsWith('samtec_refresh='));
  if (!line) {
    throw new Error('No samtec_refresh cookie was set');
  }
  return line;
}
