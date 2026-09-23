import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { BiometricRetentionService } from '../src/modules/attendance/biometric-retention.service.js';
import { signRequest } from '../src/modules/attendance/device-signature.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import {
  type AttendanceCompany,
  createAttendanceCompany,
  signedPost,
} from './attendance-fixture.js';
import { createDbTestApp } from './create-db-test-app.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The people rules of Phase 3 on a real database (docs/plan/13 section 2):
 * the duplicate review, revoke, withdrawal of consent and the two-ADMIN
 * exemption. One rule runs under all of them: nobody settles a question about
 * their own action, and nothing puts a worker to work on one person's say-so.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('The biometric people rules (e2e)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let company: AttendanceCompany;
  let kiosk: { id: string; secret: string };
  /** The ADMIN who does the enrolling, on the dashboard and on the kiosk. */
  let enroller = '';
  let enrollerOnKiosk = '';
  /** A second ADMIN, who decides what the first one may not. */
  let reviewer = '';
  /** A third ADMIN, for when the second one has touched a face themselves. */
  let secondReviewer = '';
  let thirdAdminUserId = '';

  const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
  const api = () => request(app.getHttpServer());

  const kioskPost = (route: 'kiosk/consents' | 'kiosk/face-enrollments', body: unknown) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = JSON.stringify(body);
    return api()
      .post(`/api/v1/${route}`)
      .set('Content-Type', 'application/json')
      .set(...bearer(enrollerOnKiosk))
      .set('X-Samtec-Device', kiosk.id)
      .set('X-Samtec-Timestamp', timestamp)
      .set('X-Samtec-Signature', signRequest(kiosk.secret, timestamp, route, text))
      .send(text);
  };

  let starters = 0;
  const newStarter = async () => {
    starters += 1;
    const n = String(starters).padStart(4, '0');
    return prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-73${n.slice(1)}`,
        firstName: 'Rules',
        lastName: `Starter ${starters}`,
        phone: `+23320666${n}`,
        ghanaCardNumber: `GHA-6${n.padStart(8, '0')}-${starters % 10}`,
        position: 'Security Guard',
        status: 'PENDING_ENROLLMENT',
        hireDate: new Date('2026-01-05T00:00:00Z'),
      },
    });
  };

  const cardLast4 = async (employeeId: string) => {
    const row = await prisma.employee.findFirstOrThrow({ where: { id: employeeId } });
    return row.ghanaCardNumber.replace(/\D/g, '').slice(-4);
  };

  /** Faces far enough apart to be different people (a step of 0.4 scores about 0.27). */
  let faces = 0;
  const anotherFace = () => {
    faces += 1;
    return faces * 0.4;
  };
  const sampleAt = (level: number) => ({
    model: 'human-faceres-1',
    embedding: Array.from({ length: 1024 }, () => level),
    real: 0.9,
    live: 0.9,
  });

  /** Consent and then a face, exactly as the kiosk does it. */
  const enroll = async (employeeId: string, level: number) => {
    const consent = await kioskPost('kiosk/consents', {
      employeeId,
      ghanaCardLast4: await cardLast4(employeeId),
      textVersion: 'bio-v1',
    });
    if (consent.status >= 400) {
      return consent;
    }
    return kioskPost('kiosk/face-enrollments', {
      employeeId,
      consentId: consent.body.id,
      samples: [sampleAt(level), sampleAt(level), sampleAt(level)],
    });
  };

  const panel = (token: string, employeeId: string) =>
    api()
      .get(`/api/v1/employees/${employeeId}/biometrics`)
      .set(...bearer(token));

  /** The newest face on a worker's record, whatever became of it. */
  const faceOf = (employeeId: string) =>
    prisma.biometricCredential.findFirstOrThrow({
      where: { employeeId, kind: 'FACE' },
      orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
    });

  const resolve = (token: string, credentialId: string, body: object) =>
    api()
      .post(`/api/v1/biometric-collisions/${credentialId}/resolve`)
      .set(...bearer(token))
      .send(body);

  /**
   * Every block enrols a great many people, so each takes a kiosk of its
   * own: the per-device limit of 60 signed calls a minute is then never in
   * the way of a rule this file is trying to prove.
   */
  const ownKiosk = (name: string) =>
    beforeAll(async () => {
      const registered = await api()
        .post('/api/v1/devices')
        .set(...bearer(enroller))
        .send({ name, siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      kiosk = { id: registered.body.device.id, secret: registered.body.secret };
    }, 60_000);

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    app = await createDbTestApp(databaseUrl as string);

    const tokens = app.get(TokensService);
    const sign = (userId: string, onKiosk: boolean) =>
      tokens.signAccessToken({
        userId,
        companyId: company.companyId,
        role: 'ADMIN',
        employeeId: null,
        onKiosk,
      });
    enroller = await sign(company.adminUserId, false);
    enrollerOnKiosk = await sign(company.adminUserId, true);
    reviewer = await sign(company.secondAdminUserId, false);
    const second = await prisma.user.findFirstOrThrow({
      where: { id: company.secondAdminUserId },
    });
    const third = await prisma.user.create({
      data: {
        companyId: company.companyId,
        email: `third-${second.email}`,
        passwordHash: second.passwordHash,
        fullName: 'Third Admin',
        role: 'ADMIN',
        // An ADMIN account is only usable once two-factor is set up.
        twoFactorEnabledAt: second.twoFactorEnabledAt,
        twoFactorSecretEncrypted: second.twoFactorSecretEncrypted,
      },
    });
    thirdAdminUserId = third.id;
    secondReviewer = await sign(third.id, false);

    const registered = await api()
      .post('/api/v1/devices')
      .set(...bearer(enroller))
      .send({ name: 'People rules kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
      .expect(201);
    kiosk = { id: registered.body.device.id, secret: registered.body.secret };
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('the Biometrics panel', () => {
    ownKiosk('Panel kiosk');

    it('says what a worker has, and never a template or a score', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());

      const shown = await panel(enroller, worker.id).expect(200);

      expect(shown.body.consent.status).toBe('GIVEN');
      expect(shown.body.face.status).toBe('ACTIVE');
      expect(shown.body.face.dedupe).toBe('PASSED');
      expect(shown.body.face.deviceName).toBe('Panel kiosk');
      expect(shown.body.exemption).toBeNull();
      expect(JSON.stringify(shown.body)).not.toMatch(/templateSealed|embedding|similarity|score/i);
    });

    it('shows a supervisor the reason for an exemption, never the words', async () => {
      const worker = await newStarter();
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'CANNOT_ENROLL', note: 'The scanner cannot read this worker.' })
        .expect(200);
      await prisma.siteAssignment.create({
        data: {
          companyId: company.companyId,
          employeeId: worker.id,
          siteId: company.siteA,
          startsOn: new Date('2026-01-05T00:00:00Z'),
        },
      });
      const supervisor = await app.get(TokensService).signAccessToken({
        userId: company.supervisorUserId,
        companyId: company.companyId,
        role: 'SUPERVISOR',
        employeeId: company.supervisorEmployeeId,
        onKiosk: false,
      });

      const toAdmin = await panel(enroller, worker.id).expect(200);
      const toSupervisor = await panel(supervisor, worker.id).expect(200);

      expect(toAdmin.body.exemption.note).toBe('The scanner cannot read this worker.');
      // A worker's reasons are their own: the supervisor sees only the code.
      expect(toSupervisor.body.exemption.reason).toBe('CANNOT_ENROLL');
      expect(toSupervisor.body.exemption.note).toBeNull();
    });
  });

  describe('the duplicate review', () => {
    ownKiosk('Duplicate review kiosk');

    /** A ghost enrolled with a real guard's face: the queue's whole reason to exist. */
    const aGhostAndAGuard = async () => {
      const face = anotherFace();
      const guard = await newStarter();
      await enroll(guard.id, face);
      const ghost = await newStarter();
      const enrolled = await enroll(ghost.id, face);
      expect(enrolled.body.dedupe).toBe('COLLISION');
      return { guard, ghost, credentialId: enrolled.body.credentialId as string };
    };

    it('lists what is waiting, with both names and how alike they were', async () => {
      const { guard, ghost, credentialId } = await aGhostAndAGuard();

      const queue = await api()
        .get('/api/v1/biometric-collisions')
        .set(...bearer(reviewer))
        .expect(200);

      const mine = queue.body.items.find(
        (item: { credentialId: string }) => item.credentialId === credentialId,
      );
      expect(mine.status).toBe('OPEN');
      expect(mine.employee.id).toBe(ghost.id);
      expect(mine.lookedLike.id).toBe(guard.id);
      expect(mine.similarity).toBeGreaterThan(0.5);
      expect(mine.resolution).toBeNull();
    });

    it('is never decided by the ADMIN who enrolled the face', async () => {
      const { credentialId } = await aGhostAndAGuard();

      const refused = await resolve(enroller, credentialId, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'They are brothers, I checked.',
      }).expect(403);

      expect(refused.body.detail).toMatch(/enrolled this face/);
    });

    it('clears two people who only look alike', async () => {
      const { ghost, credentialId } = await aGhostAndAGuard();

      const decided = await resolve(reviewer, credentialId, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two brothers, both cards checked in person.',
      }).expect(200);

      expect(decided.body.status).toBe('RESOLVED');
      expect(decided.body.resolution.verdict).toBe('DIFFERENT_PEOPLE');
      const shown = await panel(reviewer, ghost.id).expect(200);
      expect(shown.body.face.status).toBe('ACTIVE');
      expect(shown.body.face.dedupe).toBe('CLEARED');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: ghost.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('blocks the ghost for good when one person has two records', async () => {
      const { guard, ghost, credentialId } = await aGhostAndAGuard();

      await resolve(reviewer, credentialId, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: guard.id,
        note: 'One man, two records. The card belongs to the older record.',
      }).expect(200);

      const blocked = await panel(reviewer, ghost.id).expect(200);
      expect(blocked.body.face.status).toBe('BLOCKED');
      const ghostRow = await prisma.employee.findUniqueOrThrow({ where: { id: ghost.id } });
      expect(ghostRow.status).toBe('PENDING_ENROLLMENT');
      expect(ghostRow.biometricEnrolledAt).toBeNull();
      // The guard keeps working; the ghost can only be terminated now.
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: guard.id } })).status).toBe(
        'ACTIVE',
      );
      expect((await enroll(ghost.id, anotherFace())).status).toBe(409);

      // ...and the decision is final.
      const again = await resolve(reviewer, credentialId, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Changed my mind about this one.',
      }).expect(409);
      expect(again.body.detail).toMatch(/already been decided/);
    });

    it('keeps the real guard when the ghost was enrolled with their face first', async () => {
      const face = anotherFace();
      const ghost = await newStarter();
      await enroll(ghost.id, face);
      const guard = await newStarter();
      const guardFace = await enroll(guard.id, face);
      expect(guardFace.body.dedupe).toBe('COLLISION');

      await resolve(reviewer, guardFace.body.credentialId, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: guard.id,
        note: 'The card belongs to the newer record, not the older one.',
      }).expect(200);

      const guardPanel = await panel(reviewer, guard.id).expect(200);
      const ghostPanel = await panel(reviewer, ghost.id).expect(200);
      expect(guardPanel.body.face.status).toBe('ACTIVE');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: guard.id } })).status).toBe(
        'ACTIVE',
      );
      expect(ghostPanel.body.face.status).toBe('BLOCKED');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: ghost.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );
    });

    it('refuses a third person as the record to keep', async () => {
      const { credentialId } = await aGhostAndAGuard();
      const stranger = await newStarter();

      const refused = await resolve(reviewer, credentialId, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: stranger.id,
        note: 'Neither of the two.',
      }).expect(400);

      expect(JSON.stringify(refused.body)).toMatch(/keepEmployeeId/);
    });

    it('blocks the ghost even when its face was already wiped', async () => {
      // The insider's move: enroll a ghost with a face, and when the real
      // guard's enrollment raises the review, quietly revoke the ghost's
      // face so the honest verdict has nothing left to block.
      const oneFace = anotherFace();
      const ghost = await newStarter();
      expect((await enroll(ghost.id, oneFace)).status).toBe(201);
      const real = await newStarter();
      expect((await enroll(real.id, oneFace)).status).toBe(201);
      const review = await faceOf(real.id);
      expect(review.dedupe).toBe('COLLISION');

      // A revoke is refused while the review is open — for both records,
      // because the review is about the two of them together.
      const refused = await api()
        .post(`/api/v1/employees/${ghost.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Tidying up before anyone looks.' })
        .expect(409);
      expect(refused.body.detail).toMatch(/duplicate review/);

      // The law's own path still wipes it: the worker takes their consent
      // back, which leaves the review open with nothing live behind it.
      await api()
        .post(`/api/v1/employees/${ghost.id}/biometric-consents/withdraw`)
        .set(...bearer(reviewer))
        .send({ reason: 'The worker asked for their face to be removed.' })
        .expect(200);
      expect((await faceOf(ghost.id)).wipedAt).not.toBeNull();

      // The second ADMIN can still record the truth, and it sticks.
      const resolved = await resolve(secondReviewer, review.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: real.id,
        note: 'One man, two names: the older record is the ghost.',
      }).expect(200);

      expect(resolved.body.resolution.keptEmployeeId).toBe(real.id);
      const blocked = await faceOf(ghost.id);
      expect(blocked.status).toBe('BLOCKED');
      // The wipe keeps the name of whoever really did it — nobody re-signs it.
      expect(blocked.wipedByUserId).toBe(company.secondAdminUserId);
      // And the ghost is finished: no consent, no face, no exemption.
      const again = await enroll(ghost.id, anotherFace());
      expect(again.status).toBe(409);
      const exemption = await api()
        .post(`/api/v1/employees/${ghost.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'Trying to get the ghost working again.' });
      expect(exemption.status).toBe(409);
      // The real guard keeps their face and their job.
      expect((await faceOf(real.id)).status).toBe('ACTIVE');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: real.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('blocks the newer record after the sweep has taken its face', async () => {
      const oneFace = anotherFace();
      const real = await newStarter();
      expect((await enroll(real.id, oneFace)).status).toBe(201);
      const ghost = await newStarter();
      expect((await enroll(ghost.id, oneFace)).status).toBe(201);
      const review = await faceOf(ghost.id);
      expect(review.dedupe).toBe('COLLISION');

      // Nobody answers for 90 days, so the sweep takes the waiting face. It
      // signs its work with nobody's name, and a decision must not re-sign it.
      await prisma.attendanceCheck.updateMany({
        where: { companyId: company.companyId },
        data: { retentionCheckedAt: null },
      });
      await app
        .get(BiometricRetentionService)
        .sweep(company.companyId, new Date(Date.now() + 91 * 86_400_000));
      const swept = await faceOf(ghost.id);
      expect(swept.wipedAt).not.toBeNull();
      expect(swept.wipedByUserId).toBeNull();

      const resolved = await resolve(reviewer, review.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: real.id,
        note: 'The Ghana Cards settle it: the newer record is not a person.',
      }).expect(200);

      expect(resolved.body.resolution.verdict).toBe('SAME_PERSON');
      const blocked = await faceOf(ghost.id);
      expect(blocked.status).toBe('BLOCKED');
      // The sweep's wipe is left exactly as it was.
      expect(blocked.wipedByUserId).toBeNull();
      expect(blocked.wipedAt?.toISOString()).toBe(swept.wipedAt?.toISOString());
      expect((await faceOf(real.id)).status).toBe('ACTIVE');
    });

    it('is never decided by the ADMIN who took one of the faces off', async () => {
      const oneFace = anotherFace();
      const first = await newStarter();
      expect((await enroll(first.id, oneFace)).status).toBe(201);
      const second = await newStarter();
      expect((await enroll(second.id, oneFace)).status).toBe(201);
      const review = await faceOf(second.id);
      // The reviewer wipes one of the two faces, which puts them out.
      await api()
        .post(`/api/v1/employees/${first.id}/biometric-consents/withdraw`)
        .set(...bearer(reviewer))
        .send({ reason: 'The worker asked for their face to be removed.' })
        .expect(200);

      const refused = await resolve(reviewer, review.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two different men, I checked both cards.',
      }).expect(403);

      expect(refused.body.detail).toMatch(/removed a face/);
      // A third ADMIN, who did nothing to either record, still can.
      await resolve(secondReviewer, review.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two different men, both Ghana Cards checked in person.',
      }).expect(200);
    });

    it('refuses the enrollment itself while a review is open, not only the consent', async () => {
      const oneFace = anotherFace();
      const first = await newStarter();
      expect((await enroll(first.id, oneFace)).status).toBe(201);
      const twin = await newStarter();
      const consent = await kioskPost('kiosk/consents', {
        employeeId: twin.id,
        ghanaCardLast4: await cardLast4(twin.id),
        textVersion: 'bio-v1',
      });
      expect(consent.status).toBe(201);
      expect(
        (
          await kioskPost('kiosk/face-enrollments', {
            employeeId: twin.id,
            consentId: consent.body.id,
            samples: [sampleAt(oneFace), sampleAt(oneFace), sampleAt(oneFace)],
          })
        ).status,
      ).toBe(201);

      // The consent from before the review still exists, so this call reaches
      // the enrollment route itself: it is that route's own guard answering.
      const newFace = anotherFace();
      const refused = await kioskPost('kiosk/face-enrollments', {
        employeeId: twin.id,
        consentId: consent.body.id,
        samples: [sampleAt(newFace), sampleAt(newFace), sampleAt(newFace)],
      });

      expect(refused.status).toBe(409);
      expect(refused.body.detail).toMatch(/duplicate review/);
    });

    it('refuses to enrol when a stored face cannot be opened', async () => {
      const worker = await newStarter();
      expect((await enroll(worker.id, anotherFace())).status).toBe(201);
      // Somebody rotated the key badly, or the row was tampered with: the
      // numbers no longer open. A duplicate check that cannot read every
      // face is a guess, so the kiosk is told the door is shut.
      const stored = await faceOf(worker.id);
      await prisma.biometricCredential.update({
        where: { id: stored.id },
        data: { templateSealed: Buffer.alloc(8209, 7), keyVersion: 2 },
      });
      const other = await newStarter();

      const refused = await enroll(other.id, anotherFace());

      expect(refused.status).toBe(503);
      expect(JSON.stringify(refused.body)).not.toMatch(/embedding|template|0\.4/);
      // Nothing was written for the worker who tried.
      expect(await prisma.biometricCredential.count({ where: { employeeId: other.id } })).toBe(0);
      // Take the broken row out of the way, so the rest of this file still
      // enrols against a company whose faces all open.
      await prisma.biometricCredential.update({
        where: { id: stored.id },
        data: {
          templateSealed: null,
          keyVersion: null,
          status: 'REVOKED',
          wipedAt: new Date(),
          wipedByUserId: company.adminUserId,
        },
      });
    });
  });

  describe('revoking and withdrawing', () => {
    ownKiosk('Revoke kiosk');

    it('wipes the face and sends the worker back to waiting', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());

      const after = await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Enrolled the wrong person by mistake.' })
        .expect(200);

      expect(after.body.face.status).toBe('REVOKED');
      const row = await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } });
      expect(row.status).toBe('PENDING_ENROLLMENT');
      expect(row.biometricEnrolledAt).toBeNull();
      // Nothing left to remove the second time.
      await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Trying again.' })
        .expect(409);
    });

    it('never wipes away a question a second ADMIN owes an answer to', async () => {
      const face = anotherFace();
      const guard = await newStarter();
      await enroll(guard.id, face);
      const ghost = await newStarter();
      await enroll(ghost.id, face);

      const refused = await api()
        .post(`/api/v1/employees/${ghost.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Let me just clear this one.' })
        .expect(409);

      expect(refused.body.detail).toMatch(/duplicate review/);
    });

    it('files a request for a second ADMIN when a working worker withdraws', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());

      const after = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-consents/withdraw`)
        .set(...bearer(enroller))
        .send({ reason: 'The worker asked in writing to come off biometrics.' })
        .expect(200);

      // The face goes at once, and nobody works on one person's say-so.
      expect(after.body.face.status).toBe('REVOKED');
      expect(after.body.consent.status).toBe('WITHDRAWN');
      expect(after.body.exemption.status).toBe('REQUESTED');
      expect(after.body.exemption.reason).toBe('CONSENT_WITHDRAWN');
      expect(after.body.exemption.requestedByUserId).toBe(company.adminUserId);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );

      // The ADMIN who recorded it cannot decide it...
      const refused = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(enroller))
        .send({ decision: 'APPROVE', note: 'I recorded it, so I will approve it.' })
        .expect(403);
      expect(refused.body.detail).toMatch(/cannot decide their own request/);

      // ...and only the second one puts the worker back to work.
      const approved = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(200);
      expect(approved.body.exemption.status).toBe('APPROVED');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('never activates anybody by itself', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-consents/withdraw`)
        .set(...bearer(enroller))
        .send({ reason: 'Withdrawn in writing.' })
        .expect(200);

      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );
      // A rejection leaves them waiting, free to enrol again later.
      const rejected = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'REJECT', note: 'They will enrol again next week.' })
        .expect(200);
      expect(rejected.body.exemption.status).toBe('REJECTED');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );
    });

    it('keeps whoever removed a face from deciding about that worker', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());
      // This time the second ADMIN is the one who wipes the face.
      await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(reviewer))
        .send({ reason: 'Wrong person enrolled.' })
        .expect(200);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'The worker now refuses biometrics.' })
        .expect(200);

      const refused = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'I removed the face, so I will approve this.' })
        .expect(403);

      expect(refused.body.detail).toMatch(/removed a face/);
    });

    it('closes a review whose record another review blocked, and frees the worker it held', async () => {
      // One face, three records: the honest guard M, a ghost L, and a second
      // ghost G. L's review names M; G's review names L.
      const oneFace = anotherFace();
      const guard = await newStarter();
      expect((await enroll(guard.id, oneFace)).status).toBe(201);
      const firstGhost = await newStarter();
      expect((await enroll(firstGhost.id, oneFace)).status).toBe(201);
      const held = await faceOf(firstGhost.id);
      expect(held.dedupe).toBe('COLLISION');

      // The guard takes their consent back, which the law always allows. No
      // request is filed for a second ADMIN while that review is open.
      await api()
        .post(`/api/v1/employees/${guard.id}/biometric-consents/withdraw`)
        .set(...bearer(enroller))
        .send({ reason: 'The worker asked for their face to be removed.' })
        .expect(200);
      expect(await prisma.biometricExemption.count({ where: { employeeId: guard.id } })).toBe(0);

      // The second ghost now collides with the first ghost's waiting face.
      const secondGhost = await newStarter();
      expect((await enroll(secondGhost.id, oneFace)).status).toBe(201);
      const second = await faceOf(secondGhost.id);
      expect(second.collisionEmployeeId).toBe(firstGhost.id);

      // Deciding the second review blocks the first ghost's record — the very
      // face the first review was about.
      await resolve(reviewer, second.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: secondGhost.id,
        note: 'The older of the two is not a person.',
      }).expect(200);
      expect((await faceOf(firstGhost.id)).status).toBe('BLOCKED');

      // That first review can never be decided now, and says so plainly
      // instead of failing. It has also left the queue.
      const closed = await resolve(reviewer, held.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Trying to answer a question about a blocked record.',
      }).expect(409);
      expect(closed.body.detail).toMatch(/blocked as a duplicate by another review/);
      const queue = await api()
        .get('/api/v1/biometric-collisions?status=OPEN&limit=50')
        .set(...bearer(reviewer))
        .expect(200);
      expect(
        queue.body.items.some((item: { credentialId: string }) => item.credentialId === held.id),
      ).toBe(false);

      // And the honest guard is free again: the question that held them is
      // over, so they can enrol like anybody else.
      const again = await enroll(guard.id, anotherFace());
      expect(again.status).toBe(201);
      expect(again.body.employeeStatus).toBe('ACTIVE');
    });

    it('refuses a second, opposite decision about the same two records', async () => {
      const oneFace = anotherFace();
      const elder = await newStarter();
      expect((await enroll(elder.id, oneFace)).status).toBe(201);
      const brother = await newStarter();
      expect((await enroll(brother.id, oneFace)).status).toBe(201);
      const first = await faceOf(brother.id);
      await resolve(reviewer, first.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two brothers, both Ghana Cards checked in person.',
      }).expect(200);

      // The younger brother enrols again later, and the pair collides again.
      await api()
        .post(`/api/v1/employees/${brother.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'The camera reads him badly; taking it again.' })
        .expect(200);
      expect((await enroll(brother.id, oneFace)).status).toBe(201);
      const second = await faceOf(brother.id);
      expect(second.dedupe).toBe('COLLISION');

      // A reviewer who now wants to call it the other way is told why not,
      // instead of the database refusing it with nothing to read.
      const refused = await resolve(reviewer, second.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: elder.id,
        note: 'On second thoughts I think this is one man.',
      }).expect(409);

      expect(refused.body.detail).toMatch(/already decided to be different people/);
      // The same answer as before still goes through.
      await resolve(reviewer, second.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two brothers, as before.',
      }).expect(200);
    });
    it('is refused while an exemption request waits', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());
      // The face is taken off, then one ADMIN asks for an exemption.
      await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(reviewer))
        .send({ reason: 'Enrolled the wrong man.' })
        .expect(200);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'The worker refuses, in writing.' })
        .expect(200);

      const refused = await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Trying again while nobody is looking.' })
        .expect(409);

      expect(refused.body.detail).toMatch(/exemption request/);
    });

    it('leaves a blocked record blocked, through a revoke and a withdrawal', async () => {
      const oneFace = anotherFace();
      const real = await newStarter();
      expect((await enroll(real.id, oneFace)).status).toBe(201);
      const ghost = await newStarter();
      expect((await enroll(ghost.id, oneFace)).status).toBe(201);
      const review = await faceOf(ghost.id);
      await resolve(reviewer, review.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: real.id,
        note: 'One man, two names: the newer record is the ghost.',
      }).expect(200);
      const blocked = await faceOf(ghost.id);
      expect(blocked.status).toBe('BLOCKED');

      // A blocked record can only be terminated. Revoking is refused...
      const revoked = await api()
        .post(`/api/v1/employees/${ghost.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Trying to turn a block into a plain removal.' })
        .expect(409);
      expect(revoked.body.detail).toMatch(/blocked as a duplicate/);

      // ...and a withdrawal, which the law always allows, leaves it blocked.
      await api()
        .post(`/api/v1/employees/${ghost.id}/biometric-consents/withdraw`)
        .set(...bearer(enroller))
        .send({ reason: 'The worker asked for their record to be cleared.' })
        .expect(200);

      const after = await faceOf(ghost.id);
      expect(after.status).toBe('BLOCKED');
      expect(after.wipedAt?.toISOString()).toBe(blocked.wipedAt?.toISOString());
      // Nothing was filed for a second ADMIN: a blocked record has one way out.
      expect(await prisma.biometricExemption.count({ where: { employeeId: ghost.id } })).toBe(0);
    });

    it('leaves the first record waiting when the same face is enrolled again elsewhere', async () => {
      const oneFace = anotherFace();
      const first = await newStarter();
      expect((await enroll(first.id, oneFace)).status).toBe(201);
      // The worker takes their consent back, so the face is wiped and a
      // second ADMIN owes them an answer.
      await api()
        .post(`/api/v1/employees/${first.id}/biometric-consents/withdraw`)
        .set(...bearer(reviewer))
        .send({ reason: 'The worker asked for their face to be removed.' })
        .expect(200);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );

      // The same face now turns up on a brand-new record. It passes, because
      // the wiped face is no longer in the duplicate check.
      const second = await newStarter();
      const enrolled = await enroll(second.id, oneFace);
      expect(enrolled.status).toBe(201);
      expect(enrolled.body.dedupe).toBe('PASSED');

      // The first record does not come back on its own: it waits, unpaid,
      // for the second ADMIN who owes it an answer.
      const waiting = await prisma.employee.findUniqueOrThrow({ where: { id: first.id } });
      expect(waiting.status).toBe('PENDING_ENROLLMENT');
      expect(waiting.biometricEnrolledAt).toBeNull();
      const panelled = await panel(enroller, first.id).expect(200);
      expect(panelled.body.exemption.status).toBe('REQUESTED');
      expect(panelled.body.exemption.reason).toBe('CONSENT_WITHDRAWN');
      // The words an ADMIN typed never reach a screen: only the code does.
      expect(panelled.body.exemption.note).toBeNull();
    });
  });

  describe('exemptions', () => {
    ownKiosk('Exemption kiosk');

    it('stands when the worker later takes their consent back', async () => {
      const worker = await newStarter();
      // Consent given at the kiosk, but the camera never managed a face, so
      // two ADMINs agreed the worker may work with co-signed clock-ins.
      expect(
        (
          await kioskPost('kiosk/consents', {
            employeeId: worker.id,
            ghanaCardLast4: await cardLast4(worker.id),
            textVersion: 'bio-v1',
          })
        ).status,
      ).toBe(201);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'CANNOT_ENROLL', note: 'Three visits, no usable capture.' })
        .expect(200);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(200);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'ACTIVE',
      );

      const withdrawn = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-consents/withdraw`)
        .set(...bearer(enroller))
        .send({ reason: 'The worker no longer agrees to biometrics at all.' })
        .expect(200);

      // One ADMIN must never undo what two of them decided: there was no
      // face to take away, so the worker keeps their footing.
      expect(withdrawn.body.consent.status).toBe('WITHDRAWN');
      expect(withdrawn.body.exemption.status).toBe('APPROVED');
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('is never approved while a duplicate review about the worker is open', async () => {
      const oneFace = anotherFace();
      const guard = await newStarter();
      expect((await enroll(guard.id, oneFace)).status).toBe(201);
      const ghost = await newStarter();
      expect((await enroll(ghost.id, oneFace)).status).toBe(201);
      // A request filed before the review opened, or by any other route.
      await prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId: guard.id,
          reason: 'CONSENT_WITHDRAWN',
          requestedByUserId: company.adminUserId,
        },
      });

      const refused = await api()
        .post(`/api/v1/employees/${guard.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(409);

      expect(refused.body.detail).toMatch(/duplicate review/);
      // Rejecting is always possible, so the request is never stuck.
      await api()
        .post(`/api/v1/employees/${guard.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'REJECT', note: 'Settle the duplicate question first.' })
        .expect(200);
    });
    it('is only for a worker with no face on record', async () => {
      const worker = await newStarter();
      await enroll(worker.id, anotherFace());

      const refused = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'They changed their mind about biometrics.' })
        .expect(409);

      expect(refused.body.detail).toMatch(/waiting to be enrolled|face on record/);
    });

    it('stops consent and enrollment while it waits', async () => {
      const worker = await newStarter();
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'The worker refuses, in writing.' })
        .expect(200);

      expect((await enroll(worker.id, anotherFace())).status).toBe(409);
    });

    it('takes two ADMINs, and the second one puts the worker to work', async () => {
      const worker = await newStarter();
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'DECLINED', note: 'The worker refuses, in writing.' })
        .expect(200);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );

      const approved = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(200);

      expect(approved.body.exemption.reviewedByUserId).toBe(company.secondAdminUserId);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('is never decided by the ADMIN who enrolled a face for this worker', async () => {
      const worker = await newStarter();
      // The enroller tried a face first; the second ADMIN took it off again.
      await enroll(worker.id, anotherFace());
      await api()
        .post(`/api/v1/employees/${worker.id}/biometrics/revoke`)
        .set(...bearer(reviewer))
        .send({ reason: 'The camera never reads this worker.' })
        .expect(200);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(reviewer))
        .send({ reason: 'CANNOT_ENROLL', note: 'Three visits, no usable capture.' })
        .expect(200);

      // Approving means "this worker cannot be enrolled", which is a verdict
      // on the enroller's own attempt, so the enroller may not give it.
      const refused = await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(enroller))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(403);

      expect(refused.body.detail).toMatch(/enrolled a face/);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe(
        'PENDING_ENROLLMENT',
      );
    });

    it('ends when the worker enrols a face after all', async () => {
      const worker = await newStarter();
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'CANNOT_ENROLL', note: 'The camera could not read the face.' })
        .expect(200);
      await api()
        .post(`/api/v1/employees/${worker.id}/biometric-exemption/review`)
        .set(...bearer(reviewer))
        .send({ decision: 'APPROVE', note: 'Ghana Card checked in person.' })
        .expect(200);

      const enrolled = await enroll(worker.id, anotherFace());

      expect(enrolled.status).toBe(201);
      const shown = await panel(reviewer, worker.id).expect(200);
      expect(shown.body.exemption.status).toBe('ENDED');
      expect(shown.body.face.status).toBe('ACTIVE');
    });
  });

  /**
   * The retention sweep (docs/plan/13 section 2). It takes `now` from the
   * heartbeat, which is what lets these tests look 91 days ahead instead of
   * waiting for them.
   */
  describe('the retention sweep', () => {
    const DAY = 86_400_000;
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
    const inDays = (days: number) => new Date(Date.now() + days * DAY);
    const sweeper = () => app.get(BiometricRetentionService);

    /** The sweep runs once a day; a test that wants it again says so. */
    const dueAgain = () =>
      prisma.attendanceCheck.updateMany({
        where: { companyId: company.companyId },
        data: { retentionCheckedAt: null },
      });

    const giveKey = (employeeId: string) =>
      prisma.devicePasskey.create({
        data: {
          companyId: company.companyId,
          employeeId,
          deviceId: kiosk.id,
          credentialId: `key-${employeeId}`,
          publicKey: Buffer.from([1, 2, 3]),
          backedUp: false,
          registeredByUserId: company.adminUserId,
        },
      });

    const giveAttempt = (employeeId: string) =>
      prisma.clockInAttempt.create({
        data: {
          companyId: company.companyId,
          deviceId: kiosk.id,
          purpose: 'CLOCK',
          direction: 'IN',
          outcome: 'MATCHED',
          employeeId,
          clientAddress: '41.66.10.7',
        },
      });

    const terminate = (employeeId: string, days: number) =>
      prisma.employee.update({
        where: { id: employeeId },
        data: {
          status: 'TERMINATED',
          terminationDate: daysAgo(days),
          terminationReason: 'RESIGNED',
        },
      });

    beforeAll(async () => {
      // This block enrolls a great many people, so it takes a kiosk of its
      // own: the per-device limit of 60 signed calls a minute is then never
      // in the way. It is the last block in the file, so the swap is safe.
      const registered = await api()
        .post('/api/v1/devices')
        .set(...bearer(enroller))
        .send({ name: 'Retention kiosk', siteId: company.siteA, kind: 'FACE_KIOSK' })
        .expect(201);
      kiosk = { id: registered.body.device.id, secret: registered.body.secret };
      // Fingerprint keys are only saved on a kiosk that has them switched on.
      await prisma.device.update({ where: { id: kiosk.id }, data: { passkeysEnabled: true } });
    }, 60_000);

    it('wipes a leaver’s face and everything that described them, 90 days on', async () => {
      const gone = await newStarter();
      await enroll(gone.id, anotherFace());
      await giveKey(gone.id);
      const attempt = await giveAttempt(gone.id);
      await terminate(gone.id, 91);
      const exempted = await newStarter();
      await api()
        .post(`/api/v1/employees/${exempted.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'CANNOT_ENROLL', note: 'The scanner never read this worker.' })
        .expect(200);
      await terminate(exempted.id, 91);
      await dueAgain();

      const result = await sweeper().sweep(company.companyId, new Date());

      expect(result.ran).toBe(true);
      const face = await faceOf(gone.id);
      expect(face.status).toBe('REVOKED');
      expect(face.templateSealed).toBeNull();
      expect(face.keyVersion).toBeNull();
      expect(face.wipedAt).not.toBeNull();
      // Nobody did it by hand: that is how the sweep signs its work.
      expect(face.wipedByUserId).toBeNull();
      const key = await prisma.devicePasskey.findFirstOrThrow({ where: { employeeId: gone.id } });
      expect(key.revokedAt).not.toBeNull();
      expect(key.revokedByUserId).toBeNull();
      const cleared = await prisma.clockInAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(cleared.clientAddress).toBeNull();
      // The facts stay; only the words and the address go.
      expect(cleared.outcome).toBe('MATCHED');
      const exemption = await prisma.biometricExemption.findFirstOrThrow({
        where: { employeeId: exempted.id },
      });
      expect(exemption.note).toBeNull();
      expect(exemption.reason).toBe('CANNOT_ENROLL');
      const stillGone = await prisma.employee.findFirstOrThrow({ where: { id: gone.id } });
      expect(stillGone.status).toBe('TERMINATED');
      expect(stillGone.biometricEnrolledAt).toBeNull();
    });

    it('switches a leaver’s keys off at once, and keeps the face for 90 days', async () => {
      const recent = await newStarter();
      await enroll(recent.id, anotherFace());
      await giveKey(recent.id);
      await terminate(recent.id, 10);
      await dueAgain();

      await sweeper().sweep(company.companyId, new Date());

      const key = await prisma.devicePasskey.findFirstOrThrow({ where: { employeeId: recent.id } });
      expect(key.revokedAt).not.toBeNull();
      const face = await faceOf(recent.id);
      expect(face.status).toBe('ACTIVE');
      expect(face.templateSealed).not.toBeNull();
    });

    it('wipes a face that waited 90 days for a review, and leaves the review open', async () => {
      const level = anotherFace();
      const first = await newStarter();
      await enroll(first.id, level);
      const twin = await newStarter();
      await enroll(twin.id, level);
      const waiting = await faceOf(twin.id);
      expect(waiting.status).toBe('PENDING');
      await dueAgain();

      await sweeper().sweep(company.companyId, inDays(91));

      const wiped = await faceOf(twin.id);
      expect(wiped.status).toBe('REVOKED');
      expect(wiped.templateSealed).toBeNull();
      // The question stays: only a second ADMIN ever answers it.
      expect(wiped.verdict).toBeNull();
      const queue = await api()
        .get('/api/v1/biometric-collisions?status=OPEN&limit=50')
        .set(...bearer(reviewer))
        .expect(200);
      expect(
        queue.body.items.some((item: { credentialId: string }) => item.credentialId === waiting.id),
      ).toBe(true);
      // The worker it matched keeps their own face: only the waiting one goes.
      const kept = await faceOf(first.id);
      expect(kept.status).toBe('ACTIVE');
    });

    it('keeps the worker shut out while that wiped review is still open', async () => {
      const level = anotherFace();
      const first = await newStarter();
      await enroll(first.id, level);
      const twin = await newStarter();
      await enroll(twin.id, level);
      const waiting = await faceOf(twin.id);
      await dueAgain();
      await sweeper().sweep(company.companyId, inDays(91));
      expect((await faceOf(twin.id)).status).toBe('REVOKED');

      // The face is gone, so the row is no longer PENDING — but the question
      // is still unanswered, so nothing new may be recorded for this worker.
      expect((await enroll(twin.id, anotherFace())).status).toBe(409);
      const exemption = await api()
        .post(`/api/v1/employees/${twin.id}/biometric-exemption`)
        .set(...bearer(enroller))
        .send({ reason: 'CANNOT_ENROLL', note: 'Nobody ever answered the review.' });
      expect(exemption.status).toBe(409);
      const revoked = await api()
        .post(`/api/v1/employees/${twin.id}/biometrics/revoke`)
        .set(...bearer(enroller))
        .send({ reason: 'Tidying up.' });
      expect(revoked.status).toBe(409);

      // Deciding it opens the worker up again.
      await resolve(reviewer, waiting.id, {
        verdict: 'DIFFERENT_PEOPLE',
        note: 'Two brothers, two Ghana Cards, two different people.',
      }).expect(200);

      expect((await enroll(twin.id, anotherFace())).status).toBe(201);
    });

    it('leaves a record blocked as a duplicate exactly as it is', async () => {
      const level = anotherFace();
      const real = await newStarter();
      await enroll(real.id, level);
      const ghost = await newStarter();
      await enroll(ghost.id, level);
      const ghostFace = await faceOf(ghost.id);
      await resolve(reviewer, ghostFace.id, {
        verdict: 'SAME_PERSON',
        keepEmployeeId: real.id,
        note: 'The same man twice: one Ghana Card, two names.',
      }).expect(200);
      const blocked = await faceOf(ghost.id);
      expect(blocked.status).toBe('BLOCKED');
      await terminate(ghost.id, 91);
      await dueAgain();

      await sweeper().sweep(company.companyId, inDays(91));

      const after = await faceOf(ghost.id);
      expect(after.status).toBe('BLOCKED');
      expect(after.wipedAt?.toISOString()).toBe(blocked.wipedAt?.toISOString());
      expect(after.wipedByUserId).toBe(blocked.wipedByUserId);
    });

    it('runs on a heartbeat, and only once a day', async () => {
      await dueAgain();

      await signedPost(app, 'ingest/heartbeat', {}, kiosk).expect(200);

      const first = await prisma.attendanceCheck.findUniqueOrThrow({
        where: { companyId: company.companyId },
      });
      expect(first.retentionCheckedAt).not.toBeNull();

      await signedPost(app, 'ingest/heartbeat', {}, kiosk).expect(200);

      const second = await prisma.attendanceCheck.findUniqueOrThrow({
        where: { companyId: company.companyId },
      });
      expect(second.retentionCheckedAt?.toISOString()).toBe(
        first.retentionCheckedAt?.toISOString(),
      );
      expect((await sweeper().sweep(company.companyId, new Date())).ran).toBe(false);
    });
  });
});
