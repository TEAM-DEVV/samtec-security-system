import { createHash, randomUUID } from 'node:crypto';
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

  describe('the rules that read payroll', () => {
    /**
     * A payslip on a submitted run, for a worker with no shifts behind it.
     *
     * The rows are written straight to the tables rather than through the
     * payroll endpoints, which Samuel is still building. Every rule the
     * database enforces still applies — a run is born a DRAFT and is moved on
     * by an update, exactly as the payroll service will have to.
     */
    /** One set of rates per year for the company, made the first time a test needs it. */
    const taxTables = new Map<number, string>();
    const rates = async (maker: string, year: number) => {
      const existing = taxTables.get(year);
      if (existing) {
        return existing;
      }
      const taxTable = await prisma.taxTable.create({
        data: {
          companyId: company.companyId,
          taxYear: year,
          effectiveFrom: new Date(Date.UTC(year, 0, 1)),
          ssnitEmployeeBasisPoints: 550,
          ssnitEmployerBasisPoints: 1300,
          ssnitTier1BasisPoints: 1350,
          ssnitTier2BasisPoints: 500,
          sourceName: `GRA PAYE rates ${year}`,
          sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
          sourceCheckedOn: new Date(Date.UTC(year, 0, 5)),
          createdByUserId: maker,
          bands: {
            create: [
              {
                companyId: company.companyId,
                ordinal: 1,
                widthPesewas: 49_000,
                rateBasisPoints: 0,
              },
              {
                companyId: company.companyId,
                ordinal: 2,
                widthPesewas: null,
                rateBasisPoints: 2500,
              },
            ],
          },
        },
      });
      taxTables.set(year, taxTable.id);
      return taxTable.id;
    };

    /** One set of pay terms per worker, however many payslips they get. */
    const payTermsIds = new Map<string, string>();
    const payTermsFor = async (employeeId: string, maker: string) => {
      const existing = payTermsIds.get(employeeId);
      if (existing) {
        return existing;
      }
      const payTerms = await prisma.employeePayTerms.create({
        data: {
          companyId: company.companyId,
          employeeId,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          basicMonthlyPesewas: 200_000,
          overtimeHourlyPesewas: 900,
          createdByUserId: maker,
        },
      });
      payTermsIds.set(employeeId, payTerms.id);
      return payTerms.id;
    };

    const payslipFor = async (
      employeeId: string,
      staffNumber: string,
      month: number,
      options: { year?: number; submit?: boolean; status?: 'ACTIVE' | 'TERMINATED' } = {},
    ) => {
      const { year = 2029, submit = true, status = 'ACTIVE' } = options;
      const maker = randomUUID();
      const rateId = await rates(maker, year);
      const period = await prisma.payrollPeriod.create({
        data: {
          companyId: company.companyId,
          year,
          month,
          startsOn: new Date(Date.UTC(year, month - 1, 1)),
          endsOn: new Date(Date.UTC(year, month, 0)),
          status: 'OPEN',
        },
      });
      const payTermsId = await payTermsFor(employeeId, maker);
      const run = await prisma.payrollRun.create({
        data: {
          companyId: company.companyId,
          periodId: period.id,
          taxTableId: rateId,
          status: 'DRAFT',
          calculatedByUserId: maker,
          excludedEmployees: [],
        },
      });
      const daysInPeriod = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const line = await prisma.payrollLine.create({
        data: {
          companyId: company.companyId,
          runId: run.id,
          employeeId,
          staffNumber,
          fullName: 'Test Person',
          employeeStatus: status,
          payTermsId,
          payTermsEffectiveFrom: new Date('2020-01-01T00:00:00Z'),
          basicMonthlyPesewas: 200_000,
          overtimeHourlyPesewas: 900,
          daysInPeriod,
          daysEmployed: daysInPeriod,
          scheduledMinutes: 15_840,
          punchedMinutes: 15_840,
          // A full month of hours, and not one of them in the attendance
          // tables: the plainest shape rule R3 exists to catch.
          regularMinutes: 15_840,
          overtimeMinutes: 0,
          basicPesewas: 200_000,
          overtimePesewas: 0,
          taxableAllowancePesewas: 0,
          nonTaxableAllowancePesewas: 0,
          grossPesewas: 200_000,
          taxableGrossPesewas: 200_000,
          ssnitEmployeePesewas: 11_000,
          ssnitEmployerPesewas: 26_000,
          ssnitTier1Pesewas: 27_000,
          ssnitTier2Pesewas: 10_000,
          chargeableIncomePesewas: 189_000,
          payePesewas: 19_500,
          otherDeductionsPesewas: 0,
          netPayPesewas: 169_500,
          taxTableId: rateId,
          taxYear: year,
        },
      });
      // A run only means something once somebody has put their name to it.
      if (submit) {
        await prisma.payrollRun.update({
          where: { id: run.id },
          data: {
            status: 'PENDING_APPROVAL',
            submittedByUserId: maker,
            submittedAt: new Date(),
            submissionNote: 'Ready for checking.',
          },
        });
      }
      return { runId: run.id, lineId: line.id };
    };

    /** Somebody who left on a given day, with the record a leaver has. */
    const leaverWhoLeft = async (lastDay: string) => {
      const worker = await ghost(400);
      return prisma.employee.update({
        where: { id: worker.id },
        data: {
          status: 'TERMINATED',
          terminationDate: new Date(`${lastDay}T00:00:00.000Z`),
          terminationReason: 'RESIGNED',
        },
      });
    };

    it('asks about a payslip paying for a month with no shifts behind it (R3)', async () => {
      const worker = await ghost(400);
      // One shift in the month, and it was voided: a voided shift did not
      // happen, so it is not presence, and the month is still empty.
      await prisma.workSegment.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          siteId: company.siteA,
          workDate: new Date(Date.UTC(2029, 3, 10)),
          startedAt: new Date(Date.UTC(2029, 3, 10, 6)),
          endedAt: new Date(Date.UTC(2029, 3, 10, 18)),
          workedMinutes: 720,
          basis: 'MANUAL',
          status: 'VOIDED',
          voidedAt: new Date(),
        },
      });
      const { runId, lineId } = await payslipFor(worker.id, worker.staffNumber, 4);

      const ran = await sweep().expect(200);
      expect(ran.body.rulesRun).toContain('R3');

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R3', employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      const found = alerts.body.items[0];
      expect(found.severity).toBe('CRITICAL');
      expect(found.evidence.paidMinutes).toBe(15_840);
      expect(found.evidence.presentMinutes).toBe(0);
      expect(found.evidence.beyondToleranceMinutes).toBe(15_780);
      expect(found.evidence.runId).toBe(runId);
      expect(found.evidence.lineId).toBe(lineId);
      // Minutes and identifiers only: an alert about hours never carries pay.
      expect(JSON.stringify(found)).not.toMatch(/pesewa|netPay|bank|GHA-/i);
    });

    it('says nothing about a payslip the shifts cover (R3)', async () => {
      const worker = await ghost(400);
      // Twenty-two twelve-hour days: more than the line pays for, so the
      // tolerance is not what is keeping the rule quiet.
      for (let day = 1; day <= 22; day += 1) {
        await prisma.workSegment.create({
          data: {
            companyId: company.companyId,
            employeeId: worker.id,
            siteId: company.siteA,
            workDate: new Date(Date.UTC(2029, 4, day)),
            startedAt: new Date(Date.UTC(2029, 4, day, 6)),
            endedAt: new Date(Date.UTC(2029, 4, day, 18)),
            workedMinutes: 720,
            // MANUAL, because a segment built from a face needs the two punch
            // rows behind it and this test is about the minutes, not the
            // pairing. It counts all the same: every CONFIRMED segment does,
            // whatever its basis (docs/plan/08 §3).
            basis: 'MANUAL',
            status: 'CONFIRMED',
          },
        });
      }
      await payslipFor(worker.id, worker.staffNumber, 5);

      await sweep().expect(200);

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R3', employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(alerts.body.items).toHaveLength(0);
    });

    it("leaves a clerk's unfinished draft alone (R3)", async () => {
      const worker = await ghost(400);
      await payslipFor(worker.id, worker.staffNumber, 6, { submit: false });

      await sweep().expect(200);

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R3', employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      // A draft is still being worked on. Nobody has put their name to it,
      // so it is not yet a claim about anything.
      expect(alerts.body.items).toHaveLength(0);
    });

    it('asks about somebody still being paid after they left, but not for the month they left in (R6)', async () => {
      const leaver = await leaverWhoLeft('2026-05-15');
      // May contains the leaving day and pays the fifteen days they worked;
      // June began after they had gone.
      await payslipFor(leaver.id, leaver.staffNumber, 5, { year: 2026, status: 'TERMINATED' });
      await payslipFor(leaver.id, leaver.staffNumber, 6, { year: 2026, status: 'TERMINATED' });

      await sweep().expect(200);

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R6', employeeId: leaver.id })
        .set(...bearer(adminToken))
        .expect(200);
      const found = alerts.body.items[0];
      expect(found.evidence.leftOn).toBe('2026-05-15');
      expect(found.evidence.paidPeriodsAfter).toEqual(['2026-06']);
      expect(found.evidence.punchesAfter).toBe(0);
    });

    it('asks about somebody still clocking in after they left (R6)', async () => {
      await prisma.punchEvent.create({
        data: {
          companyId: company.companyId,
          deviceId: coSignKiosk,
          siteId: company.siteA,
          deviceEventId: `left-${Date.now()}`,
          deviceUserRef: company.leaver.staffNumber,
          employeeId: company.leaver.id,
          deviceTime: new Date(),
          serverTime: new Date(),
          direction: 'IN',
          method: 'FACE',
          payloadHash: createHash('sha256').update(`left-${Date.now()}`).digest('hex'),
        },
      });

      const ran = await sweep().expect(200);
      expect(ran.body.rulesRun).toContain('R6');

      const alerts = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R6', employeeId: company.leaver.id })
        .set(...bearer(adminToken))
        .expect(200);
      const found = alerts.body.items[0];
      expect(found.severity).toBe('CRITICAL');
      expect(found.evidence.leftOn).toBe(company.leaverLastDay);
      expect(found.evidence.punchesAfter).toBeGreaterThanOrEqual(1);
      expect(found.evidence.paidPeriodsAfter).toEqual([]);
    });
  });

  describe('the daily run', () => {
    /**
     * Makes this test's company the only one due, and nobody else.
     *
     * The daily run is deliberately global — it sweeps whichever companies
     * are due — and the local database holds every company earlier runs and
     * other test files left behind. Marking them all as swept just now is
     * what keeps this test from reaching into another file's data while both
     * run. A company created by another file **after** this runs is safe too:
     * the daily run gives a company with no bookmark one dated now, so its
     * first sweep is the next day, never this call.
     *
     * The bookmark is bookkeeping only; no other test reads `swept_at`.
     */
    const onlyThisCompanyDue = async () => {
      const unmarked = await prisma.company.findMany({
        where: { detectionCheck: null },
        select: { id: true },
      });
      await prisma.detectionCheck.createMany({
        data: unmarked.map((row) => ({ companyId: row.id, sweptAt: new Date() })),
        skipDuplicates: true,
      });
      await prisma.detectionCheck.updateMany({
        where: { companyId: { not: company.companyId } },
        data: { sweptAt: new Date() },
      });
      await prisma.detectionCheck.upsert({
        where: { companyId: company.companyId },
        create: { companyId: company.companyId, sweptAt: new Date(0) },
        update: { sweptAt: new Date(0) },
      });
    };

    it('sweeps a company that is due with nobody signed in, and records the system as the actor', async () => {
      const worker = await ghost(40);
      await onlyThisCompanyDue();

      const ran = await api().get('/api/v1/detection/daily-sweep').expect(200);

      expect(ran.body.companiesSwept).toBeGreaterThanOrEqual(1);
      // A count, and nothing that names anybody.
      expect(Object.keys(ran.body)).toEqual(['companiesSwept']);
      const check = await prisma.detectionCheck.findUniqueOrThrow({
        where: { companyId: company.companyId },
      });
      expect(Date.now() - check.sweptAt.getTime()).toBeLessThan(60_000);
      expect(
        await prisma.detectionAlert.count({ where: { ruleCode: 'R5', employeeId: worker.id } }),
      ).toBe(1);
      const audit = await prisma.auditLog.findFirst({
        where: { companyId: company.companyId, action: 'detection.swept' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.actorUserId).toBeNull();
    });

    it('gives a brand-new company a bookmark, and sweeps it tomorrow rather than now', async () => {
      const fresh = await prisma.company.create({ data: { name: `Daily run ${randomUUID()}` } });
      await onlyThisCompanyDue();

      await api().get('/api/v1/detection/daily-sweep').expect(200);

      const bookmark = await prisma.detectionCheck.findUnique({
        where: { companyId: fresh.id },
      });
      // It has one now, dated now — so it is not due, and nothing was swept
      // for it. A company with no attendance yet has nothing to find, and a
      // burst of new companies never becomes a burst of sweeps.
      expect(bookmark).not.toBeNull();
      expect(Date.now() - (bookmark?.sweptAt.getTime() ?? 0)).toBeLessThan(60_000);
      expect(await prisma.detectionAlert.count({ where: { companyId: fresh.id } })).toBe(0);
    });

    it('does nothing for a company already swept in the last twenty hours', async () => {
      await onlyThisCompanyDue();
      await api().get('/api/v1/detection/daily-sweep').expect(200);
      const first = await prisma.detectionCheck.findUniqueOrThrow({
        where: { companyId: company.companyId },
      });

      // Called again straight away, as anybody could. Nothing moves: either
      // the minute-long "nothing due" answer replies from memory, or the
      // twenty-hour gap refuses the company again.
      await api().get('/api/v1/detection/daily-sweep').expect(200);

      const second = await prisma.detectionCheck.findUniqueOrThrow({
        where: { companyId: company.companyId },
      });
      expect(second.sweptAt).toEqual(first.sweptAt);
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
    it('lists all eleven, every one of them built and switched on', async () => {
      const rules = await api()
        .get('/api/v1/detection/rules')
        .set(...bearer(adminToken))
        .expect(200);

      expect(rules.body.items).toHaveLength(11);
      const built = rules.body.items.filter((rule: { enabled: boolean }) => rule.enabled);
      // Every one of the eleven now, so a quiet queue really is a quiet queue.
      expect(built.map((rule: { code: string }) => rule.code).sort()).toEqual([
        'R1',
        'R10',
        'R11',
        'R2',
        'R3',
        'R4',
        'R5',
        'R6',
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

    it('never lets a decision about administrators weigh on a worker (R11)', async () => {
      const worker = await ghost(40);
      await sweep().expect(200);
      const before = await api()
        .get('/api/v1/detection/risk-scores')
        .query({ limit: 100 })
        .set(...bearer(adminToken))
        .expect(200);
      const scoreOf = (body: { items: { employee: { id: string }; score: number }[] }) =>
        body.items.find((row) => row.employee.id === worker.id)?.score ?? 0;

      // An R11 alert lands on this worker's file: it names them so a checker
      // can find the record, but it asks about who settled a decision.
      await prisma.detectionAlert.create({
        data: {
          companyId: company.companyId,
          ruleCode: 'R11',
          severity: 'HIGH',
          employeeId: worker.id,
          dedupeKey: `R11:review:score-test-${randomUUID()}`,
          windowFrom: new Date(Date.now() - DAY_MS),
          windowTo: new Date(),
          evidence: { decision: 'duplicate review', recordId: 'made-up-for-this-test' },
        },
      });

      const after = await api()
        .get('/api/v1/detection/risk-scores')
        .query({ limit: 100 })
        .set(...bearer(adminToken))
        .expect(200);

      // The queue shows it; the worker's score does not move.
      expect(scoreOf(after.body)).toBe(scoreOf(before.body));
      const queue = await api()
        .get('/api/v1/detection/alerts')
        .query({ ruleCode: 'R11', employeeId: worker.id })
        .set(...bearer(adminToken))
        .expect(200);
      expect(queue.body.items).toHaveLength(1);
    });
  });
});
