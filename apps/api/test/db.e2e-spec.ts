import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokensService } from '../src/modules/identity/tokens.service.js';
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
  SUPERVISOR_EMPLOYEE_ID,
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

/** Signing in always says which page it came from; the browser sets this itself. */
const DASHBOARD_ORIGIN = 'http://localhost:5173';
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
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    expect(response.body.status).toBe('AUTHENTICATED');
    return response.body.accessToken;
  }

  /** Signs the admin in: password first, then a real code from the known secret. */
  async function twoFactorSignIn(): Promise<string> {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email: EMAILS.admin, password: TEST_PASSWORD })
      .expect(200);
    expect(login.body.status).toBe('TWO_FACTOR_REQUIRED');

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/2fa/verify')
      .set('Origin', DASHBOARD_ORIGIN)
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
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'nobody@dbtest.example', password: TEST_PASSWORD })
        .expect(401);
      const wrong = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: EMAILS.hr, password: 'wrong-password' })
        .expect(401);

      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('sets the refresh cookie with the attributes the contract promises', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
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
          .set('Origin', DASHBOARD_ORIGIN)
          .send({ email: 'lock-me@dbtest.example', password: 'guess' })
          .expect(401);
      }

      const locked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'lock-me@dbtest.example', password: 'guess' })
        .expect(429);

      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(locked.body.detail).toContain('Try again in');
    });

    it('walks HR through two-factor setup, and requires the code from then on', async () => {
      // 1. Password is right, but this role must set up two-factor first.
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: EMAILS.hr, password: TEST_PASSWORD })
        .expect(200);
      expect(login.body.status).toBe('TWO_FACTOR_SETUP_REQUIRED');

      // 2. Get the QR code (as its otpauth link and manual key).
      const setup = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/setup')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ setupToken: login.body.setupToken })
        .expect(200);
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/SAMTEC:/);
      const secret = setup.body.manualEntryKey;

      // 3. A wrong first code does not enable anything.
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/enable')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ setupToken: login.body.setupToken, code: '000000' })
        .expect(401);

      // 4. The right code proves the app works: two-factor is on, user signed in.
      const usedStep = totpStep();
      const enabled = await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/enable')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ setupToken: login.body.setupToken, code: totpCode(secret, usedStep) })
        .expect(200);
      expect(enabled.body.user.twoFactorEnabled).toBe(true);

      // 5. Signing in again now asks for a code…
      const nextLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: EMAILS.hr, password: TEST_PASSWORD })
        .expect(200);
      expect(nextLogin.body.status).toBe('TWO_FACTOR_REQUIRED');

      // 6. …and the code that was already used is refused (replay protection)…
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/verify')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ challengeToken: nextLogin.body.challengeToken, code: totpCode(secret, usedStep) })
        .expect(401);

      // 7. …while the next step's code signs them in.
      await request(app.getHttpServer())
        .post('/api/v1/auth/2fa/verify')
        .set('Origin', DASHBOARD_ORIGIN)
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
        .set('Origin', DASHBOARD_ORIGIN)
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

  describe('rosters (posts and shift patterns)', () => {
    let nightShiftId = '';
    let mainGateId = '';

    it('creates a shift pattern and knows when it crosses midnight', async () => {
      const night = await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.admin))
        .send({ name: 'Night Shift', startTime: '18:00', endTime: '06:00' })
        .expect(201);
      expect(night.body.crossesMidnight).toBe(true);
      nightShiftId = night.body.id;

      const day = await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.admin))
        .send({ name: 'Day Shift', startTime: '06:00', endTime: '18:00' })
        .expect(201);
      expect(day.body.crossesMidnight).toBe(false);

      // The same name twice is a clear conflict, and bad times a clear 400.
      await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.admin))
        .send({ name: 'Night Shift', startTime: '19:00', endTime: '07:00' })
        .expect(409);
      const badTime = await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.admin))
        .send({ name: 'Odd Shift', startTime: '25:00', endTime: '07:00' })
        .expect(400);
      expect(badTime.body.errors[0].path).toBe('startTime');

      // Equal times would be a zero-length shift — refused on create and update.
      const equalTimes = await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.admin))
        .send({ name: 'Ghost Shift', startTime: '08:00', endTime: '08:00' })
        .expect(400);
      expect(equalTimes.body.errors[0].path).toBe('endTime');
      await request(app.getHttpServer())
        .patch(`/api/v1/shift-patterns/${nightShiftId}`)
        .set(...bearer(tokens.admin))
        .send({ endTime: '18:00' }) // The night shift starts at 18:00.
        .expect(400);
    });

    it('lists shift patterns for a supervisor, but only HR and admins write', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/shift-patterns')
        .set(...bearer(tokens.supervisor))
        .expect(200);
      expect(list.body.items.map((item: { name: string }) => item.name)).toEqual([
        'Day Shift',
        'Night Shift',
      ]);

      await request(app.getHttpServer())
        .post('/api/v1/shift-patterns')
        .set(...bearer(tokens.supervisor))
        .send({ name: 'Sneaky Shift', startTime: '08:00', endTime: '16:00' })
        .expect(403);
    });

    it('creates posts at a site, refusing duplicates', async () => {
      const created = await request(app.getHttpServer())
        .post(`/api/v1/sites/${SITE_1_ID}/posts`)
        .set(...bearer(tokens.admin))
        .send({ name: 'Main Gate', requiredGuards: 2 })
        .expect(201);
      expect(created.body.siteId).toBe(SITE_1_ID);
      expect(created.body.status).toBe('ACTIVE');
      mainGateId = created.body.id;

      await request(app.getHttpServer())
        .post(`/api/v1/sites/${SITE_1_ID}/posts`)
        .set(...bearer(tokens.admin))
        .send({ name: 'Main Gate' })
        .expect(409);
      // The same name at ANOTHER site is fine.
      await request(app.getHttpServer())
        .post(`/api/v1/sites/${SITE_2_ID}/posts`)
        .set(...bearer(tokens.admin))
        .send({ name: 'Main Gate' })
        .expect(201);
    });

    it("shows a supervisor only their own site's posts (404 elsewhere)", async () => {
      const own = await request(app.getHttpServer())
        .get(`/api/v1/sites/${SITE_1_ID}/posts`)
        .set(...bearer(tokens.supervisor))
        .expect(200);
      expect(own.body.items.map((item: { name: string }) => item.name)).toEqual(['Main Gate']);

      await request(app.getHttpServer())
        .get(`/api/v1/sites/${SITE_2_ID}/posts`)
        .set(...bearer(tokens.supervisor))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/sites/${SITE_1_ID}/posts`)
        .set(...bearer(tokens.guard))
        .expect(403);
    });

    it('assigns an employee to a post and shift, and rejects mismatches', async () => {
      // A post from another site cannot sneak in.
      const wrongSite = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${SUPERVISOR_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ siteId: SITE_2_ID, postId: mainGateId })
        .expect(400);
      expect(wrongSite.body.errors[0].path).toBe('postId');

      // A post without a site makes no sense.
      const noSite = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${SUPERVISOR_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ postId: mainGateId })
        .expect(400);
      expect(noSite.body.errors[0].path).toBe('postId');

      const assigned = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${SUPERVISOR_EMPLOYEE_ID}`)
        .set(...bearer(tokens.admin))
        .send({ siteId: SITE_1_ID, postId: mainGateId, shiftPatternId: nightShiftId })
        .expect(200);
      expect(assigned.body.currentSite.id).toBe(SITE_1_ID);
      expect(assigned.body.currentPost).toEqual({ id: mainGateId, name: 'Main Gate' });
      expect(assigned.body.currentShiftPattern).toMatchObject({
        name: 'Night Shift',
        startTime: '18:00',
        endTime: '06:00',
      });
    });

    it('updates a post and retires it without deleting', async () => {
      const renamed = await request(app.getHttpServer())
        .patch(`/api/v1/posts/${mainGateId}`)
        .set(...bearer(tokens.admin))
        .send({ requiredGuards: 3, status: 'INACTIVE' })
        .expect(200);
      expect(renamed.body.requiredGuards).toBe(3);
      expect(renamed.body.status).toBe('INACTIVE');

      await request(app.getHttpServer())
        .patch(`/api/v1/posts/${mainGateId}`)
        .set(...bearer(tokens.supervisor))
        .send({ status: 'ACTIVE' })
        .expect(403);
    });
  });

  describe('user management', () => {
    const NEW_PASSWORD = 'a long guard password';

    /** Creates a fresh employee (so every test owns its data) and returns its ID. */
    async function newEmployee(ghanaCard: string): Promise<string> {
      const created = await request(app.getHttpServer())
        .post('/api/v1/employees')
        .set(...bearer(tokens.admin))
        .send({
          firstName: 'Kweku',
          lastName: 'Ansah',
          phone: '+233209999950',
          ghanaCardNumber: ghanaCard,
          position: 'Security Guard',
          hireDate: '2026-09-01',
          siteId: SITE_1_ID,
        })
        .expect(201);
      return created.body.id;
    }

    /** Creates a GUARD account for a fresh employee, sets its password, and signs it in. */
    async function signedInGuard(email: string, ghanaCard: string) {
      const employeeId = await newEmployee(ghanaCard);
      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set(...bearer(tokens.admin))
        .send({ email, fullName: 'Kweku Ansah', role: 'GUARD', employeeId })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/set-password')
        .send({ token: created.body.passwordSetup.token, newPassword: NEW_PASSWORD })
        .expect(204);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email, password: NEW_PASSWORD })
        .expect(200);
      return {
        userId: created.body.user.id as string,
        employeeId,
        accessToken: login.body.accessToken as string,
        cookie: readSetCookie(login.headers['set-cookie']).split(';')[0] ?? '',
      };
    }

    it('creates an account that waits for its owner to choose a password', async () => {
      const employeeId = await newEmployee('GHA-955555100-1');
      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set(...bearer(tokens.admin))
        .send({
          email: 'Kweku.Guard@DBTEST.example',
          fullName: 'Kweku Ansah',
          role: 'GUARD',
          employeeId,
        })
        .expect(201);

      expect(created.headers.location).toBe(`/api/v1/users/${created.body.user.id}`);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body.user).toMatchObject({
        email: 'kweku.guard@dbtest.example',
        role: 'GUARD',
        status: 'AWAITING_PASSWORD',
        employeeId,
      });
      const { token } = created.body.passwordSetup;

      // No password yet, so nothing can sign in to it — not even a guess.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'kweku.guard@dbtest.example', password: NEW_PASSWORD })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/set-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);
      // The link worked once.
      const reused = await request(app.getHttpServer())
        .post('/api/v1/auth/set-password')
        .send({ token, newPassword: 'another long password' })
        .expect(400);
      expect(reused.body.errors[0].path).toBe('token');

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'kweku.guard@dbtest.example', password: NEW_PASSWORD })
        .expect(200);
      expect(login.body.status).toBe('AUTHENTICATED');
      // The guard sees their own record through the link.
      await request(app.getHttpServer())
        .get(`/api/v1/employees/${employeeId}`)
        .set(...bearer(login.body.accessToken))
        .expect(200);

      // Neither the link token nor the password is stored or audited anywhere.
      const prisma = openFixtureDb(databaseUrl as string);
      const [users, challenges, audits] = await Promise.all([
        prisma.user.findMany({ where: { id: created.body.user.id } }),
        prisma.authChallenge.findMany({ where: { userId: created.body.user.id } }),
        prisma.auditLog.findMany({ where: { entityId: created.body.user.id } }),
      ]);
      await prisma.$disconnect();
      const everything = JSON.stringify({ users, challenges, audits });
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(NEW_PASSWORD);
      expect(challenges).toHaveLength(0);
      expect(audits.map((row) => row.action)).toEqual(
        expect.arrayContaining(['user.created', 'auth.password_set']),
      );
    });

    it('enforces the employee link, one account per person and unique emails', async () => {
      const post = (body: object) =>
        request(app.getHttpServer())
          .post('/api/v1/users')
          .set(...bearer(tokens.admin))
          .send(body);

      const unlinkedGuard = await post({
        email: 'g1@dbtest.example',
        fullName: 'No Link',
        role: 'GUARD',
      }).expect(400);
      expect(unlinkedGuard.body.errors[0].path).toBe('employeeId');

      const linkedAdmin = await post({
        email: 'a1@dbtest.example',
        fullName: 'Linked Admin',
        role: 'ADMIN',
        employeeId: GUARD_EMPLOYEE_ID,
      }).expect(400);
      expect(linkedAdmin.body.errors[0].path).toBe('employeeId');

      const unknown = await post({
        email: 'g2@dbtest.example',
        fullName: 'Nobody',
        role: 'GUARD',
        employeeId: '01927c3e-0000-7000-8000-00000000dead',
      }).expect(400);
      expect(unknown.body.errors[0].path).toBe('employeeId');

      // Already has an account, has left the company, or the email is taken.
      await post({
        email: 'g3@dbtest.example',
        fullName: 'Twice',
        role: 'GUARD',
        employeeId: GUARD_EMPLOYEE_ID,
      }).expect(409);
      await post({
        email: 'g4@dbtest.example',
        fullName: 'Leaver',
        role: 'GUARD',
        employeeId: TERMINATED_EMPLOYEE_ID,
      }).expect(409);
      await post({
        email: EMAILS.hr.toUpperCase(),
        fullName: 'Same Email',
        role: 'HR_PAYROLL',
      }).expect(409);
    });

    it('is for administrators only', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set(...bearer(tokens.supervisor))
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${GUARD_EMPLOYEE_ID}/deactivate`)
        .set(...bearer(tokens.guard))
        .expect(403);
      await request(app.getHttpServer()).get('/api/v1/users').expect(401);
    });

    it('pages through accounts, oldest first, with no personal data in the cursor', async () => {
      const first = await request(app.getHttpServer())
        .get('/api/v1/users?limit=2')
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.items[0]).not.toHaveProperty('passwordHash');
      expect(Buffer.from(first.body.nextCursor, 'base64url').toString()).toBe(
        first.body.items[1].id,
      );
      const second = await request(app.getHttpServer())
        .get(`/api/v1/users?limit=2&cursor=${first.body.nextCursor}`)
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(second.body.items[0].id > first.body.items[1].id).toBe(true);
    });

    it('never lets an administrator change, switch off or reset their own account', async () => {
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(tokens.admin))
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/users/${me.body.id}`)
        .set(...bearer(tokens.admin))
        .send({ role: 'HR_PAYROLL' })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${me.body.id}/deactivate`)
        .set(...bearer(tokens.admin))
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${me.body.id}/reset-sign-in`)
        .set(...bearer(tokens.admin))
        .expect(409);
      // Their own name is fine.
      const renamed = await request(app.getHttpServer())
        .patch(`/api/v1/users/${me.body.id}`)
        .set(...bearer(tokens.admin))
        .send({ fullName: 'Efua Admin-Mensah' })
        .expect(200);
      expect(renamed.body.fullName).toBe('Efua Admin-Mensah');
    });

    it('switching an account off stops its access token at once and ends its sessions', async () => {
      const guard = await signedInGuard('switch.off@dbtest.example', 'GHA-955555101-2');

      const off = await request(app.getHttpServer())
        .post(`/api/v1/users/${guard.userId}/deactivate`)
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(off.body.status).toBe('DEACTIVATED');

      // Not in 15 minutes: on the very next request.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(guard.accessToken))
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', guard.cookie)
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'switch.off@dbtest.example', password: NEW_PASSWORD })
        .expect(401);

      // Switched back on, the person signs in again; old sessions stay dead.
      await request(app.getHttpServer())
        .post(`/api/v1/users/${guard.userId}/reactivate`)
        .set(...bearer(tokens.admin))
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', guard.cookie)
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'switch.off@dbtest.example', password: NEW_PASSWORD })
        .expect(200);
    });

    it('a promotion ends every session, and the new ADMIN must set up two-factor', async () => {
      const guard = await signedInGuard('promoted@dbtest.example', 'GHA-955555102-3');

      await request(app.getHttpServer())
        .patch(`/api/v1/users/${guard.userId}`)
        .set(...bearer(tokens.admin))
        .send({ role: 'ADMIN', employeeId: null })
        .expect(200);

      // The GUARD token is dead, and sign-in now demands a second factor.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(guard.accessToken))
        .expect(401);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'promoted@dbtest.example', password: NEW_PASSWORD })
        .expect(200);
      expect(login.body.status).toBe('TWO_FACTOR_SETUP_REQUIRED');
    });

    it('reset sign-in clears the password AND the authenticator, and issues a new link', async () => {
      const users = await request(app.getHttpServer())
        .get('/api/v1/users?limit=100')
        .set(...bearer(tokens.admin))
        .expect(200);
      const hr = users.body.items.find((item: { email: string }) => item.email === EMAILS.hr);
      expect(hr.twoFactorEnabled).toBe(true); // Set up in the two-factor walkthrough above.

      const reset = await request(app.getHttpServer())
        .post(`/api/v1/users/${hr.id}/reset-sign-in`)
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(reset.headers['cache-control']).toBe('no-store');
      expect(reset.body.user).toMatchObject({
        status: 'AWAITING_PASSWORD',
        twoFactorEnabled: false,
      });

      // The old password is dead at once.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: EMAILS.hr, password: TEST_PASSWORD })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/set-password')
        .send({ token: reset.body.passwordSetup.token, newPassword: 'the new hr password' })
        .expect(204);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: EMAILS.hr, password: 'the new hr password' })
        .expect(200);
      // A new authenticator must be set up: a stolen password is not enough.
      expect(login.body.status).toBe('TWO_FACTOR_SETUP_REQUIRED');
    });

    it('terminating an employee switches their account off, for good', async () => {
      const guard = await signedInGuard('leaver@dbtest.example', 'GHA-955555103-4');

      await request(app.getHttpServer())
        .post(`/api/v1/employees/${guard.employeeId}/terminate`)
        .set(...bearer(tokens.admin))
        .send({ effectiveDate: '2026-09-30', reason: 'RESIGNED' })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(...bearer(guard.accessToken))
        .expect(401);
      const account = await request(app.getHttpServer())
        .get(`/api/v1/users/${guard.userId}`)
        .set(...bearer(tokens.admin))
        .expect(200);
      expect(account.body.status).toBe('DEACTIVATED');
      // Someone who has left cannot be switched back on.
      await request(app.getHttpServer())
        .post(`/api/v1/users/${guard.userId}/reactivate`)
        .set(...bearer(tokens.admin))
        .expect(409);
    });

    it('changes your own password: 400 for a wrong one, then every session ends', async () => {
      const guard = await signedInGuard('changer@dbtest.example', 'GHA-955555104-5');

      const wrong = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set(...bearer(guard.accessToken))
        .send({ currentPassword: 'not my password', newPassword: 'a brand new password' })
        .expect(400);
      expect(wrong.body.errors[0].path).toBe('currentPassword');

      const changed = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set(...bearer(guard.accessToken))
        .send({ currentPassword: NEW_PASSWORD, newPassword: 'a brand new password' })
        .expect(204);
      expect(readSetCookie(changed.headers['set-cookie'])).toContain('samtec_refresh=;');

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', guard.cookie)
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
        .send({ email: 'changer@dbtest.example', password: 'a brand new password' })
        .expect(200);
    });

    it('two administrators switching each other off at once leave one administrator', async () => {
      const prisma = openFixtureDb(databaseUrl as string);
      const [admin, admin2] = await Promise.all([
        prisma.user.findFirstOrThrow({ where: { email: EMAILS.admin } }),
        prisma.user.findFirstOrThrow({ where: { email: EMAILS.admin2 } }),
      ]);
      const admin2Token = await app.get(TokensService).signAccessToken({
        userId: admin2.id,
        companyId: admin2.companyId,
        role: 'ADMIN',
        onKiosk: false,
        employeeId: null,
      });

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/users/${admin2.id}/deactivate`)
          .set(...bearer(tokens.admin)),
        request(app.getHttpServer())
          .post(`/api/v1/users/${admin.id}/deactivate`)
          .set(...bearer(admin2Token)),
      ]);
      // One wins; the other is refused because its own account was just switched off.
      expect([first.status, second.status].sort()).toEqual([200, 401]);
      const activeAdmins = await prisma.user.count({
        where: { companyId: admin.companyId, role: 'ADMIN', isActive: true },
      });
      await prisma.$disconnect();
      expect(activeAdmins).toBeGreaterThanOrEqual(1);

      // Put the loser back, so the tests after this one keep their admin.
      const survivorToken = first.status === 200 ? tokens.admin : admin2Token;
      const loserId = first.status === 200 ? admin2.id : admin.id;
      await request(app.getHttpServer())
        .post(`/api/v1/users/${loserId}/reactivate`)
        .set(...bearer(survivorToken))
        .expect(200);
    });
  });

  describe('sign-in throttle (atomic counting)', () => {
    function wrongLogin(email: string) {
      return request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', DASHBOARD_ORIGIN)
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
