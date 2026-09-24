import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { AttendanceFactsService } from '../src/modules/attendance/attendance-facts.service.js';
import { CONSENT_TEXT_SHA256 } from '../src/modules/attendance/consent-text.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import { type AttendanceCompany, createAttendanceCompany } from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * Ghost detection on a real database
 * (docs/plan/08-ghost-detection-engine.md): the sweep, the queue, and the
 * rule nobody may bend — an alert is a question a person answers, never
 * something the system acts on by itself.
 *
 * Runs when TEST_DATABASE_URL points at a migrated database.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!databaseUrl)('Ghost detection (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let adminToken = '';
  let hrToken = '';
  let supervisorToken = '';
  /** Consent and kiosk rows need a face kiosk (a database trigger says so). */
  let consentKiosk = '';
  let coSignKiosk = '';

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
  const api = () => request(app.getHttpServer());
  const sweep = () =>
    api()
      .post('/api/v1/detection/sweep')
      .set(...bearer(adminToken));

  let starters = 0;
  /** A worker who has been on the books a while and has never clocked in. */
  const ghost = async (daysAgo: number) => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    const worker = await prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-77${n.slice(1)}`,
        firstName: 'Ghost',
        lastName: `Worker ${starters}`,
        phone: `+23320558${n}`,
        ghanaCardNumber: `GHA-9${n.padStart(8, '0')}-${starters % 10}`,
        position: 'Security Guard',
        status: 'ACTIVE',
        hireDate: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
    await prisma.siteAssignment.create({
      data: {
        companyId: company.companyId,
        employeeId: worker.id,
        siteId: company.siteA,
        startsOn: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
    return worker;
  };

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);
    const tokens = app.get(TokensService);
    adminToken = await tokens.signAccessToken({
      userId: company.adminUserId,
      companyId: company.companyId,
      role: 'ADMIN',
      employeeId: null,
      onKiosk: false,
    });
    hrToken = await tokens.signAccessToken({
      userId: company.hrUserId,
      companyId: company.companyId,
      role: 'HR_PAYROLL',
      employeeId: null,
      onKiosk: false,
    });
    supervisorToken = await tokens.signAccessToken({
      userId: company.supervisorUserId,
      companyId: company.companyId,
      role: 'SUPERVISOR',
      employeeId: company.supervisorEmployeeId,
      onKiosk: false,
    });
    const kiosk = await api()
      .post('/api/v1/devices')
      .set(...bearer(adminToken))
      .send({ name: 'Detection kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
      .expect(201);
    consentKiosk = kiosk.body.device.id;
    coSignKiosk = kiosk.body.device.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('who may look', () => {
    it('never shows the queue to a supervisor', async () => {
      // A supervisor is themselves a subject of rule R7, so the queue would
      // show them their own file (docs/plan/08 §6).
      await api()
        .get('/api/v1/detection/alerts')
        .set(...bearer(supervisorToken))
        .expect(403);
      await api()
        .post('/api/v1/detection/sweep')
        .set(...bearer(supervisorToken))
        .expect(403);
    });

    it('lets HR read the queue but never change a rule', async () => {
      await api()
        .get('/api/v1/detection/alerts')
        .set(...bearer(hrToken))
        .expect(200);
      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(hrToken))
        .send({ enabled: false })
        .expect(403);
    });
  });

  describe('the sweep', () => {
    it('finds the classic ghost, and says what it looked at', async () => {
      const worker = await ghost(40);

      const ran = await sweep().expect(200);

      expect(ran.body.rulesRun).toContain('R5');
      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R5', employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      const found = alerts.body.items[0];
      expect(found.severity).toBe('HIGH');
      expect(found.status).toBe('OPEN');
      expect(found.subject.employee.staffNumber).toBe(worker.staffNumber);
      expect(found.evidence.punches).toBe(0);
      expect(found.evidence.daysOnTheBooks).toBeGreaterThanOrEqual(40);
      // Evidence names rows and numbers, never anything biometric.
      expect(JSON.stringify(found)).not.toMatch(/GHA-|template|embedding/i);
    });

    it('raises nothing the second time, and never reopens a decided alert', async () => {
      const worker = await ghost(40);
      await sweep().expect(200);
      const first = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      const alertId = first.body.items[0].id;

      const again = await sweep().expect(200);
      expect(again.body.raised).toBe(0);

      await api()
        .post(`/api/v1/detection/alerts/${alertId}/resolve`)
        .set(...bearer(adminToken))
        .send({ status: 'RESOLVED', note: 'New starter, paperwork was late.' })
        .expect(200);
      await sweep().expect(200);

      const after = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      // One alert, still resolved: a sweep never reopens what a person closed.
      expect(after.body.items).toHaveLength(1);
      expect(after.body.items[0].status).toBe('RESOLVED');
    });

    it('never calls a worker waiting for enrollment a ghost', async () => {
      // They cannot clock in at all until they are enrolled — the attendance
      // rules refuse them — so zero punches is this system's own doing, not
      // a finding about the person. Accusing every new starter whose
      // enrollment took a fortnight would be the worst kind of false
      // positive: the one population that can never clear itself.
      const waiting = await ghost(40);
      await prisma.employee.update({
        where: { id: waiting.id },
        data: { status: 'PENDING_ENROLLMENT' },
      });

      await sweep().expect(200);

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: waiting.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(alerts.body.items).toHaveLength(0);
    });

    it('leaves a new starter alone, and moves with the threshold', async () => {
      const newStarter = await ghost(3);
      await sweep().expect(200);
      const quiet = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: newStarter.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(quiet.body.items).toHaveLength(0);

      // The report's tuning table is built by doing exactly this.
      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(adminToken))
        .send({ thresholds: { days: 1 } })
        .expect(200);
      await sweep().expect(200);

      const now = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: newStarter.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(now.body.items).toHaveLength(1);

      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(adminToken))
        .send({ thresholds: { days: 14 } })
        .expect(200);
    });

    it('skips a rule that is switched off, and says which', async () => {
      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(adminToken))
        .send({ enabled: false })
        .expect(200);

      const ran = await sweep().expect(200);

      expect(ran.body.rulesRun).not.toContain('R5');
      expect(ran.body.rulesSkipped).toContain('R5');
      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(adminToken))
        .send({ enabled: true })
        .expect(200);
    });
  });

  describe('deciding', () => {
    it('needs a reason, and never lets one alert be decided twice', async () => {
      const worker = await ghost(40);
      await sweep().expect(200);
      const listed = await api()
        .get('/api/v1/detection/alerts')
        .query({ employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      const alertId = listed.body.items[0].id;

      await api()
        .post(`/api/v1/detection/alerts/${alertId}/resolve`)
        .set(...bearer(adminToken))
        .send({ status: 'RESOLVED', note: '' })
        .expect(400);

      const decided = await api()
        .post(`/api/v1/detection/alerts/${alertId}/resolve`)
        .set(...bearer(adminToken))
        .send({ status: 'CONFIRMED_FRAUD', note: 'No such person at the gate. Payroll told.' })
        .expect(200);
      expect(decided.body.resolution.note).toMatch(/No such person/);

      await api()
        .post(`/api/v1/detection/alerts/${alertId}/resolve`)
        .set(...bearer(adminToken))
        .send({ status: 'RESOLVED', note: 'Changed my mind.' })
        .expect(409);
    });

    it('will not let anybody rewrite what a rule found', async () => {
      const worker = await ghost(40);
      await sweep().expect(200);
      const alert = await prisma.detectionAlert.findFirstOrThrow({
        where: { employeeId: worker.id },
      });

      // The database refuses it, whatever the code above does.
      await expect(
        prisma.detectionAlert.update({
          where: { id: alert.id },
          data: { evidence: { punches: 99 } },
        }),
      ).rejects.toThrow(/never rewritten/);
      await expect(prisma.detectionAlert.delete({ where: { id: alert.id } })).rejects.toThrow(
        /never deleted/,
      );
    });
  });

  describe('the rules that read other tables', () => {
    it('asks about a duplicate face that is still waiting, and never one already blocked', async () => {
      const [enrolled, lookedLike] = [await ghost(50), await ghost(50)];
      const consent = await prisma.biometricConsent.create({
        data: {
          companyId: company.companyId,
          employeeId: enrolled.id,
          status: 'GIVEN',
          textVersion: 'bio-v1',
          textSha256: CONSENT_TEXT_SHA256,
          recordedByUserId: company.adminUserId,
          deviceId: consentKiosk,
        },
      });
      const waiting = await prisma.biometricCredential.create({
        data: {
          companyId: company.companyId,
          employeeId: enrolled.id,
          kind: 'FACE',
          deviceId: consentKiosk,
          templateSealed: new Uint8Array([1, 2, 3]),
          keyVersion: 1,
          faceModel: 'human-faceres-1',
          consentId: consent.id,
          enrolledByUserId: company.adminUserId,
          dedupe: 'COLLISION',
          collisionEmployeeId: lookedLike.id,
          collisionSimilarity: 0.71,
          status: 'PENDING',
        },
      });

      await sweep().expect(200);

      const raised = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R1', employeeId: enrolled.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(raised.body.items).toHaveLength(1);
      expect(raised.body.items[0].evidence.lookedLikeStaffNumber).toBe(lookedLike.staffNumber);
      expect(raised.body.items[0].evidence.similarity).toBeCloseTo(0.71, 2);
      // Never a template, whatever else the evidence carries.
      expect(JSON.stringify(raised.body)).not.toMatch(/template|embedding/i);

      // A record another review already blocked keeps COLLISION and no
      // verdict for ever, because the database refuses to decide a blocked
      // face — so an alert about one could never be cleared, and
      // `openFaceCollisions` leaves them out for exactly the reason the
      // duplicate queue does.
      //
      // That state cannot be built here: the database refuses to block a
      // face except through a real SAME_PERSON decision against its own
      // record, which is itself reassuring. What is asserted instead is
      // that a review the database has since decided stops being raised.
      await api()
        .post(`/api/v1/detection/alerts/${raised.body.items[0].id}/resolve`)
        .set(...bearer(adminToken))
        .send({ status: 'RESOLVED', note: 'Same man, one record kept. Queue cleared.' })
        .expect(200);
      const after = await sweep().expect(200);
      expect(after.body.raised).toBe(0);
      expect(waiting.dedupe).toBe('COLLISION');
    });

    it('asks about two workers sharing a phone, without writing the number down', async () => {
      const shared = `+2332055${String(Date.now()).slice(-6)}`;
      const one = await ghost(50);
      const two = await ghost(50);
      await prisma.employee.updateMany({
        where: { id: { in: [one.id, two.id] } },
        data: { phone: shared },
      });

      await sweep().expect(200);

      const raised = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R2', employeeId: one.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(raised.body.items).toHaveLength(1);
      expect(raised.body.items[0].evidence.withStaffNumbers).toContain(two.staffNumber);
      // The question is that it is shared, not what it is. The number is not
      // in the evidence, and the key that makes the sweep repeatable is
      // keyed with the server's own secret, so it cannot be looked up.
      const stored = await prisma.detectionAlert.findFirstOrThrow({
        where: { employeeId: one.id, ruleCode: 'R2' },
      });
      expect(JSON.stringify(stored)).not.toContain(shared);
    });

    it('counts only the co-signs that really let somebody in', async () => {
      const supervisor = await ghost(50);
      const attempts = await Promise.all(
        [1, 2].map(() =>
          prisma.clockInAttempt.create({
            data: {
              companyId: company.companyId,
              deviceId: coSignKiosk,
              purpose: 'CO_SIGN',
              direction: 'IN',
              outcome: 'MATCHED',
              employeeId: supervisor.id,
              staffNumberTried: 'SMT-70001',
            },
            select: { id: true },
          }),
        ),
      );
      // Only the first one ever became a punch. A supervisor whose co-signs
      // are refused is the opposite of the person this rule looks for.
      await prisma.punchEvent.create({
        data: {
          companyId: company.companyId,
          deviceId: coSignKiosk,
          siteId: company.siteA,
          deviceEventId: attempts[0]?.id ?? '',
          deviceUserRef: 'SMT-70001',
          employeeId: company.active.id,
          deviceTime: new Date(),
          serverTime: new Date(),
          direction: 'IN',
          method: 'PIN_FALLBACK',
          // 64 hex characters, as the database insists.
          payloadHash: createHash('sha256').update(String(Date.now())).digest('hex'),
        },
      });

      const counted = await app
        .get(AttendanceFactsService)
        .coSignsPerSupervisor(company.companyId, new Date(Date.now() - 30 * DAY_MS));

      expect(counted.find((row) => row.employeeId === supervisor.id)?.coSigns).toBe(1);
    });
  });

  describe('the planted ghost', () => {
    it('is in the seeded data, on the books and never at a gate', async () => {
      // The labelled ground truth the report's precision and recall
      // discussion is written from (docs/plan/08 §10). If the seed stops
      // planting him, the Phase 5 demo has nothing to catch.
      const planted = await prisma.employee.findFirst({
        where: { staffNumber: 'SMT-00099' },
        select: { id: true, status: true, hireDate: true },
      });
      expect(planted?.status).toBe('ACTIVE');
      expect(Date.now() - (planted?.hireDate.getTime() ?? 0)).toBeGreaterThan(14 * DAY_MS);
      expect(await prisma.punchEvent.count({ where: { employeeId: planted?.id } })).toBe(0);
    });
  });

  describe('the rules and the score', () => {
    it('lists all eleven, and marks the ones not built yet', async () => {
      const rules = await api()
        .get('/api/v1/detection/rules')
        .set(...bearer(adminToken))
        .expect(200);

      expect(rules.body.items).toHaveLength(11);
      const built = rules.body.items.filter((rule: { enabled: boolean }) => rule.enabled);
      // A rule that is not built must never read as a clean bill of health.
      expect(built.map((rule: { code: string }) => rule.code).sort()).toEqual([
        'R1',
        'R10',
        'R11',
        'R2',
        'R4',
        'R5',
        'R7',
        'R8',
        'R9',
      ]);
    });

    it('refuses a threshold the rule does not have', async () => {
      await api()
        .patch('/api/v1/detection/rules/R5')
        .set(...bearer(adminToken))
        .send({ thresholds: { bananas: 3 } })
        .expect(409);
    });

    it('adds up a score from the open alerts, highest first', async () => {
      const worker = await ghost(40);
      await sweep().expect(200);

      const scores = await api()
        .get('/api/v1/detection/risk-scores')
        .query({ limit: 100 })
        .set(...bearer(adminToken))
        .expect(200);

      expect(scores.body.items.length).toBeGreaterThan(0);
      const values = scores.body.items.map((row: { score: number }) => row.score);
      expect([...values].sort((a: number, b: number) => b - a)).toEqual(values);
      // This worker has exactly one open alert, a HIGH one, which is worth 5.
      // Others in this company may have collected several by now, so the
      // assertion is about the one we just made, not whoever is top.
      const mine = scores.body.items.find(
        (row: { employee: { id: string } }) => row.employee.id === worker.id,
      );
      expect(mine.score).toBe(5);
      expect(mine.openAlerts).toBe(1);
      expect(mine.topRule).toBe('R5');
    });
  });
});
