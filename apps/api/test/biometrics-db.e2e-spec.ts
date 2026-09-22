import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { type AttendanceCompany, createAttendanceCompany } from './attendance-fixture.js';
import { openFixtureDb } from './db-fixture.js';

/**
 * The Phase 3 biometric tables on a real PostgreSQL database: the rules the
 * database itself enforces (CHECKs, partial unique indexes and triggers), so
 * that a bug in the application can never unblock a duplicate, bring back a
 * wiped face, let one ADMIN approve their own request, or rewrite history.
 * docs/plan/13-biometrics-design.md §1. The API that uses these tables comes
 * in later pull requests; these tests write to the tables directly.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const SHA256 = 'a'.repeat(64);
const TEMPLATE = new Uint8Array([7, 7, 7]);
/** Two fictional ADMIN user IDs: one who enrolls, one who decides. */
const ENROLLER = '01927c3e-2222-7ccc-9ddd-0000000e0001';
const REVIEWER = '01927c3e-2222-7ccc-9ddd-0000000e0002';

describe.skipIf(!databaseUrl)('Phase 3 biometric tables on a real database (e2e)', () => {
  let prisma: PrismaClient;
  let company: AttendanceCompany;
  let kioskId = '';
  let faceOnlyKioskId = '';
  let terminalId = '';

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    const device = (name: string, kind: 'FACE_KIOSK' | 'ZKTECO', passkeysEnabled = false) =>
      prisma.device.create({
        data: {
          companyId: company.companyId,
          siteId: company.siteA,
          name,
          kind,
          passkeysEnabled,
          secretEncrypted: 'v1$not$a$secret',
        },
      });
    // Fingerprint keys may only be saved on a kiosk with fingerprints switched on.
    kioskId = (await device('Rules kiosk', 'FACE_KIOSK', true)).id;
    faceOnlyKioskId = (await device('Rules face-only kiosk', 'FACE_KIOSK')).id;
    terminalId = (await device('Rules terminal', 'ZKTECO')).id;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const consent = (employeeId: string) =>
    prisma.biometricConsent.create({
      data: {
        companyId: company.companyId,
        employeeId,
        status: 'GIVEN',
        textVersion: 'bio-v1',
        textSha256: SHA256,
        recordedByUserId: ENROLLER,
        deviceId: kioskId,
      },
    });

  /** A face that passed the duplicate check, as enrollment will store it. */
  const face = async (employeeId: string, extra: Record<string, unknown> = {}) =>
    prisma.biometricCredential.create({
      data: {
        companyId: company.companyId,
        employeeId,
        kind: 'FACE',
        deviceId: kioskId,
        templateSealed: TEMPLATE,
        keyVersion: 1,
        faceModel: 'human-faceres-1',
        consentId: (await consent(employeeId)).id,
        enrolledByUserId: ENROLLER,
        dedupe: 'PASSED',
        status: 'ACTIVE',
        ...extra,
      },
    });

  /** A face that looked like someone else, waiting for a second ADMIN. */
  const collision = (employeeId: string, lookalikeId: string) =>
    face(employeeId, {
      dedupe: 'COLLISION',
      status: 'PENDING',
      collisionEmployeeId: lookalikeId,
      collisionSimilarity: 0.71,
    });

  /** The fields a second ADMIN's decision sets. */
  const decision = (verdict: 'DIFFERENT_PEOPLE' | 'SAME_PERSON', by = REVIEWER) => ({
    verdict,
    resolutionNote: 'Both Ghana Cards checked in person.',
    resolvedByUserId: by,
    resolvedAt: new Date(),
  });

  const wiped = { templateSealed: null, keyVersion: null, wipedAt: new Date() };

  /** A fresh fictional new starter, for tests that need someone with no face yet. */
  let extraCount = 0;
  const newStarter = () => {
    extraCount += 1;
    const n = String(extraCount).padStart(4, '0');
    return prisma.employee.create({
      data: {
        companyId: company.companyId,
        staffNumber: `SMT-71${n.slice(1)}`,
        firstName: 'Test',
        lastName: `Starter ${extraCount}`,
        phone: `+23320888${n}`,
        ghanaCardNumber: `GHA-9${n.padStart(8, '0')}-${extraCount % 10}`,
        position: 'Security Guard',
        status: 'PENDING_ENROLLMENT',
        hireDate: new Date('2026-01-05T00:00:00Z'),
      },
    });
  };

  describe('consents', () => {
    it('are append-only: a withdrawal is a new row', async () => {
      const row = await consent(company.active.id);
      await expect(
        prisma.biometricConsent.update({ where: { id: row.id }, data: { textVersion: 'bio-v2' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.biometricConsent.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        prisma.$executeRawUnsafe('TRUNCATE biometric_consents CASCADE'),
      ).rejects.toThrow();
    });

    it('are given on a kiosk, and record the SHA-256 of the exact text', async () => {
      const base = {
        companyId: company.companyId,
        employeeId: company.active.id,
        textVersion: 'bio-v1',
        recordedByUserId: ENROLLER,
      };
      await expect(
        prisma.biometricConsent.create({
          data: { ...base, status: 'GIVEN', textSha256: SHA256, deviceId: null },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.biometricConsent.create({
          data: { ...base, status: 'GIVEN', textSha256: 'not-a-hash', deviceId: kioskId },
        }),
      ).rejects.toThrow();
      // A withdrawal may be recorded on the dashboard, with no device.
      await prisma.biometricConsent.create({
        data: { ...base, status: 'WITHDRAWN', textSha256: SHA256, deviceId: null },
      });
    });
  });

  describe('faces', () => {
    it('allow one face in use per employee, and a new one only after the old is wiped', async () => {
      const first = await face(company.leaver.id);
      await expect(face(company.leaver.id)).rejects.toThrow();
      await prisma.biometricCredential.update({
        where: { id: first.id },
        data: { ...wiped, status: 'REVOKED', wipedByUserId: ENROLLER },
      });
      await face(company.leaver.id);
    });

    it('never bring a wiped face back, and a wipe is never undone', async () => {
      const row = await face(company.suspended.id);
      await prisma.biometricCredential.update({
        where: { id: row.id },
        data: { ...wiped, status: 'REVOKED' },
      });
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { templateSealed: TEMPLATE, keyVersion: 1, wipedAt: null, status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/never come back|never be/);
      await expect(
        prisma.biometricCredential.update({ where: { id: row.id }, data: { status: 'ACTIVE' } }),
      ).rejects.toThrow();
    });

    it('keep a template only while the face is in use, with the key that sealed it', async () => {
      // An ACTIVE face with no template, or a template with no key, is refused.
      await expect(face(company.supervisorEmployeeId, { templateSealed: null })).rejects.toThrow();
      await expect(face(company.supervisorEmployeeId, { keyVersion: null })).rejects.toThrow();
    });

    it('never change the facts of an enrollment', async () => {
      const row = await face(company.supervisorEmployeeId);
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { employeeId: company.active.id },
        }),
      ).rejects.toThrow(/facts of an enrollment/);
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { enrolledByUserId: REVIEWER },
        }),
      ).rejects.toThrow(/facts of an enrollment/);
    });

    it('may only be sealed again with a newer key (key rotation), never swapped', async () => {
      const row = await prisma.biometricCredential.findFirstOrThrow({
        where: { employeeId: company.supervisorEmployeeId, wipedAt: null },
      });
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { templateSealed: new Uint8Array([9, 9, 9]) },
        }),
      ).rejects.toThrow(/newer key/);
      await prisma.biometricCredential.update({
        where: { id: row.id },
        data: { templateSealed: new Uint8Array([9, 9, 9]), keyVersion: 2 },
      });
    });

    it('are never deleted or truncated', async () => {
      const row = await prisma.biometricCredential.findFirstOrThrow({
        where: { companyId: company.companyId },
      });
      await expect(prisma.biometricCredential.delete({ where: { id: row.id } })).rejects.toThrow(
        /never deleted/,
      );
      await expect(
        prisma.$executeRawUnsafe('TRUNCATE biometric_credentials CASCADE'),
      ).rejects.toThrow();
    });
  });

  describe('collision decisions', () => {
    it('never let a face that collided come into use without a decision', async () => {
      const lookalike = await newStarter();
      await face(lookalike.id);
      const row = await collision((await newStarter()).id, lookalike.id);
      // Straight to ACTIVE, or marked CLEARED, with no verdict: both refused.
      await expect(
        prisma.biometricCredential.update({ where: { id: row.id }, data: { status: 'ACTIVE' } }),
      ).rejects.toThrow(/biometric_credentials_status_valid/);
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { dedupe: 'CLEARED', status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/biometric_credentials_decision_valid/);
      // Wiped while waiting (a withdrawal, say): the review stays open, and
      // marking it CLEARED with no verdict is still refused.
      await prisma.biometricCredential.update({
        where: { id: row.id },
        data: { ...wiped, status: 'REVOKED' },
      });
      await expect(
        prisma.biometricCredential.update({ where: { id: row.id }, data: { dedupe: 'CLEARED' } }),
      ).rejects.toThrow(/biometric_credentials_decision_valid/);
    });

    it('are never made by the ADMIN who enrolled the face', async () => {
      const row = await collision(company.active.id, company.supervisorEmployeeId);
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { ...decision('DIFFERENT_PEOPLE', ENROLLER), dedupe: 'CLEARED', status: 'ACTIVE' },
        }),
      ).rejects.toThrow();
    });

    it('record who, when and why together, and are final once made', async () => {
      const row = await prisma.biometricCredential.findFirstOrThrow({
        where: { employeeId: company.active.id, status: 'PENDING' },
      });
      // A verdict with no note is refused.
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { ...decision('DIFFERENT_PEOPLE'), resolutionNote: null, dedupe: 'CLEARED' },
        }),
      ).rejects.toThrow();
      await prisma.biometricCredential.update({
        where: { id: row.id },
        data: { ...decision('DIFFERENT_PEOPLE'), dedupe: 'CLEARED', status: 'ACTIVE' },
      });
      await expect(
        prisma.biometricCredential.update({
          where: { id: row.id },
          data: { verdict: 'SAME_PERSON', keptEmployeeId: company.active.id },
        }),
      ).rejects.toThrow(/final/);
    });

    it('make SAME_PERSON name one of the two records, and block the other for good', async () => {
      // The leaver enrolls again (their earlier face is wiped first, one face at
      // a time) and looks like the supervisor, whose older record is the real one.
      const lookalike = await prisma.biometricCredential.findFirstOrThrow({
        where: { employeeId: company.supervisorEmployeeId, wipedAt: null },
      });
      const earlier = await prisma.biometricCredential.findFirstOrThrow({
        where: { employeeId: company.leaver.id, wipedAt: null },
      });
      await prisma.biometricCredential.update({
        where: { id: earlier.id },
        data: { ...wiped, status: 'REVOKED' },
      });
      const duplicate = await collision(company.leaver.id, lookalike.employeeId);

      // A third person's record cannot be the one kept.
      await expect(
        prisma.biometricCredential.update({
          where: { id: duplicate.id },
          data: {
            ...decision('SAME_PERSON'),
            keptEmployeeId: company.active.id,
            ...wiped,
            status: 'BLOCKED',
          },
        }),
      ).rejects.toThrow();

      await prisma.biometricCredential.update({
        where: { id: duplicate.id },
        data: {
          ...decision('SAME_PERSON'),
          keptEmployeeId: lookalike.employeeId,
          ...wiped,
          status: 'BLOCKED',
        },
      });
      // Nothing turns a block back: not a revoke, not a return to use.
      await expect(
        prisma.biometricCredential.update({
          where: { id: duplicate.id },
          data: { status: 'REVOKED' },
        }),
      ).rejects.toThrow(/can never become/);
    });

    it('let SAME_PERSON keep the new record, clearing its face and blocking the older one', async () => {
      // An insider enrolled a ghost with a real guard's face; the real guard enrolls again.
      const ghost = await newStarter();
      const ghostFace = await face(ghost.id);
      const guard = await newStarter();
      const guardFace = await collision(guard.id, ghost.id);
      const keepGuard = prisma.biometricCredential.update({
        where: { id: guardFace.id },
        data: {
          ...decision('SAME_PERSON'),
          keptEmployeeId: guard.id,
          dedupe: 'CLEARED',
          status: 'ACTIVE',
        },
      });
      const blockGhost = prisma.biometricCredential.update({
        where: { id: ghostFace.id },
        data: { ...wiped, status: 'BLOCKED' },
      });

      // The decision alone would leave the ghost clocking in; a block alone has no decision.
      await expect(keepGuard).rejects.toThrow(/must block the other record/);
      await expect(blockGhost).rejects.toThrow(/blocked only by a SAME_PERSON decision/);
      // Together, in one transaction, both hold.
      await prisma.$transaction([
        prisma.biometricCredential.update({
          where: { id: guardFace.id },
          data: {
            ...decision('SAME_PERSON'),
            keptEmployeeId: guard.id,
            dedupe: 'CLEARED',
            status: 'ACTIVE',
          },
        }),
        prisma.biometricCredential.update({
          where: { id: ghostFace.id },
          data: { ...wiped, status: 'BLOCKED' },
        }),
      ]);
      await expect(
        prisma.biometricCredential.update({
          where: { id: ghostFace.id },
          data: { status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/can never become/);
    });
  });

  describe('new rows', () => {
    it('start with no decision', async () => {
      const lookalike = await newStarter();
      await face(lookalike.id);
      await expect(
        collision((await newStarter()).id, lookalike.id).then(() => undefined),
      ).resolves.toBeUndefined();
      // A face inserted already cleared, as if a second ADMIN had decided it.
      await expect(
        face((await newStarter()).id, {
          dedupe: 'CLEARED',
          collisionEmployeeId: lookalike.id,
          collisionSimilarity: 0.9,
          ...decision('DIFFERENT_PEOPLE'),
        }),
      ).rejects.toThrow(/starts with no decision/);
      // An exemption inserted already approved.
      await expect(
        prisma.biometricExemption.create({
          data: {
            companyId: company.companyId,
            employeeId: (await newStarter()).id,
            reason: 'DECLINED',
            requestedByUserId: ENROLLER,
            status: 'APPROVED',
            reviewedByUserId: REVIEWER,
            reviewedAt: new Date(),
            reviewNote: 'Ghana Card checked in person.',
          },
        }),
      ).rejects.toThrow(/starts waiting/);
    });

    it('belong on the right kind of device', async () => {
      await expect(face((await newStarter()).id, { deviceId: terminalId })).rejects.toThrow(
        /enrolled on a face kiosk/,
      );
      const finger = (deviceId: string) =>
        newStarter().then((worker) =>
          prisma.biometricCredential.create({
            data: {
              companyId: company.companyId,
              employeeId: worker.id,
              kind: 'TERMINAL_FINGER',
              deviceId,
              dedupe: 'NOT_CHECKED',
              status: 'ACTIVE',
            },
          }),
        );
      await expect(finger(kioskId)).rejects.toThrow(/never comes from a kiosk/);
      await finger(terminalId);
    });

    it("use this worker's own consent, given and not withdrawn since", async () => {
      const first = await newStarter();
      const second = await newStarter();
      const firstConsent = await consent(first.id);
      await expect(face(second.id, { consentId: firstConsent.id })).rejects.toThrow(
        /own, given and not withdrawn/,
      );
      await prisma.biometricConsent.create({
        data: {
          companyId: company.companyId,
          employeeId: first.id,
          status: 'WITHDRAWN',
          textVersion: 'bio-v1',
          textSha256: SHA256,
          recordedByUserId: ENROLLER,
          recordedAt: new Date(firstConsent.recordedAt.getTime() + 1_000),
        },
      });
      await expect(face(first.id, { consentId: firstConsent.id })).rejects.toThrow(
        /own, given and not withdrawn/,
      );
    });

    it('give nothing new to a record blocked as a duplicate', async () => {
      // The leaver's record lost a SAME_PERSON decision above.
      const blocked = company.leaver.id;
      await expect(face(blocked)).rejects.toThrow(/can only be terminated/);
      await expect(
        prisma.biometricExemption.create({
          data: {
            companyId: company.companyId,
            employeeId: blocked,
            reason: 'DECLINED',
            requestedByUserId: ENROLLER,
          },
        }),
      ).rejects.toThrow(/can only be terminated/);
      await expect(
        prisma.devicePasskey.create({
          data: {
            companyId: company.companyId,
            employeeId: blocked,
            deviceId: kioskId,
            credentialId: `blocked-key-${company.companyId}`,
            publicKey: new Uint8Array([1]),
            backedUp: false,
            registeredByUserId: ENROLLER,
          },
        }),
      ).rejects.toThrow(/can only be terminated/);
      // A withdrawal of consent is still recorded, as the law requires.
      await prisma.biometricConsent.create({
        data: {
          companyId: company.companyId,
          employeeId: blocked,
          status: 'WITHDRAWN',
          textVersion: 'bio-v1',
          textSha256: SHA256,
          recordedByUserId: ENROLLER,
        },
      });
    });
  });

  describe('exemptions', () => {
    const request = (employeeId: string, by = ENROLLER) =>
      prisma.biometricExemption.create({
        data: {
          companyId: company.companyId,
          employeeId,
          reason: 'DECLINED',
          note: 'Declined in writing.',
          requestedByUserId: by,
        },
      });
    const review = (by: string, status: 'APPROVED' | 'REJECTED' = 'APPROVED') => ({
      status,
      reviewedByUserId: by,
      reviewedAt: new Date(),
      reviewNote: 'Ghana Card checked in person.',
    });

    it('are never decided by the ADMIN who asked', async () => {
      const row = await request(company.active.id);
      await expect(
        prisma.biometricExemption.update({ where: { id: row.id }, data: review(ENROLLER) }),
      ).rejects.toThrow();
      await prisma.biometricExemption.update({ where: { id: row.id }, data: review(REVIEWER) });
    });

    it('allow one request waiting or approved per employee', async () => {
      await expect(request(company.active.id)).rejects.toThrow();
    });

    it('only move forward, and a decision is final', async () => {
      const row = await prisma.biometricExemption.findFirstOrThrow({
        where: { employeeId: company.active.id, status: 'APPROVED' },
      });
      await expect(
        prisma.biometricExemption.update({
          where: { id: row.id },
          data: { status: 'REQUESTED', reviewedAt: null, reviewedByUserId: null, reviewNote: null },
        }),
      ).rejects.toThrow(/can never become|final/);
      await expect(
        prisma.biometricExemption.update({
          where: { id: row.id },
          data: { reviewNote: 'Changed my mind about the reason.' },
        }),
      ).rejects.toThrow(/final/);
      // Ending it is the way forward; then a new request may be made.
      await prisma.biometricExemption.update({
        where: { id: row.id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      await request(company.active.id);
    });

    it('let the retention sweep clear a note, but never rewrite it', async () => {
      const row = await prisma.biometricExemption.findFirstOrThrow({
        where: { employeeId: company.active.id, status: 'REQUESTED' },
      });
      await expect(
        prisma.biometricExemption.update({
          where: { id: row.id },
          data: { note: 'A different story.' },
        }),
      ).rejects.toThrow(/only be cleared/);
      await prisma.biometricExemption.update({ where: { id: row.id }, data: { note: null } });
      await expect(prisma.biometricExemption.delete({ where: { id: row.id } })).rejects.toThrow(
        /never deleted/,
      );
    });

    it('take a decision only on a waiting request, in one step', async () => {
      // A request that ended undecided can never be given a decision afterwards...
      const ended = await request((await newStarter()).id);
      await prisma.biometricExemption.update({
        where: { id: ended.id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      const { status: _approved, ...decisionOnly } = review(REVIEWER);
      await expect(
        prisma.biometricExemption.update({ where: { id: ended.id }, data: decisionOnly }),
      ).rejects.toThrow(/only on a waiting request/);
      // ...and a waiting request cannot end with a decision attached.
      const waiting = await request((await newStarter()).id);
      await expect(
        prisma.biometricExemption.update({
          where: { id: waiting.id },
          data: { ...review(REVIEWER), status: 'ENDED', endedAt: new Date() },
        }),
      ).rejects.toThrow(/only on a waiting request/);
    });
  });

  describe('fingerprint keys', () => {
    // Key IDs are unique across the whole database and rows are never deleted,
    // so each run uses its own (the company ID is new every run).
    const key = (employeeId: string, name: string) =>
      prisma.devicePasskey.create({
        data: {
          companyId: company.companyId,
          employeeId,
          deviceId: kioskId,
          credentialId: `${name}-${company.companyId}`,
          publicKey: new Uint8Array([1, 2, 3]),
          backedUp: false,
          registeredByUserId: ENROLLER,
        },
      });

    it('allow one live key per worker per kiosk, and a revoke is final', async () => {
      const first = await key(company.active.id, 'key-a1');
      await expect(key(company.active.id, 'key-a2')).rejects.toThrow();
      await prisma.devicePasskey.update({
        where: { id: first.id },
        data: { revokedAt: new Date(), revokedByUserId: REVIEWER },
      });
      await key(company.active.id, 'key-a3');
      await expect(
        prisma.devicePasskey.update({ where: { id: first.id }, data: { revokedAt: null } }),
      ).rejects.toThrow(/revoke is final/);
    });

    it('never let the signature counter go down (a sign of a cloned key)', async () => {
      const row = await key(company.suspended.id, 'key-b1');
      await prisma.devicePasskey.update({ where: { id: row.id }, data: { signCount: 5n } });
      await expect(
        prisma.devicePasskey.update({ where: { id: row.id }, data: { signCount: 4n } }),
      ).rejects.toThrow(/only go up/);
      await expect(
        prisma.devicePasskey.update({
          where: { id: row.id },
          data: { publicKey: new Uint8Array([4]) },
        }),
      ).rejects.toThrow(/never changes/);
      await expect(prisma.devicePasskey.delete({ where: { id: row.id } })).rejects.toThrow(
        /never deleted/,
      );
    });

    it('are saved only on a kiosk with fingerprints switched on', async () => {
      const worker = await newStarter();
      const onDevice = (deviceId: string, name: string) =>
        prisma.devicePasskey.create({
          data: {
            companyId: company.companyId,
            employeeId: worker.id,
            deviceId,
            credentialId: `${name}-${company.companyId}`,
            publicKey: new Uint8Array([1]),
            backedUp: false,
            registeredByUserId: ENROLLER,
          },
        });
      await expect(onDevice(terminalId, 'key-terminal')).rejects.toThrow(/switched on/);
      await expect(onDevice(faceOnlyKioskId, 'key-face-only')).rejects.toThrow(/switched on/);
    });

    it('may become synced but never hide it, and a revoked key is never used', async () => {
      const row = await key((await newStarter()).id, 'key-c1');
      await prisma.devicePasskey.update({ where: { id: row.id }, data: { backedUp: true } });
      await expect(
        prisma.devicePasskey.update({ where: { id: row.id }, data: { backedUp: false } }),
      ).rejects.toThrow(/stays marked synced/);
      await prisma.devicePasskey.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokedByUserId: REVIEWER },
      });
      await expect(
        prisma.devicePasskey.update({
          where: { id: row.id },
          data: { signCount: 1n, lastUsedAt: new Date() },
        }),
      ).rejects.toThrow(/never used/);
    });
  });

  describe('clock-in attempts', () => {
    const attempt = (extra: Record<string, unknown>) =>
      prisma.clockInAttempt.create({
        data: {
          companyId: company.companyId,
          deviceId: kioskId,
          purpose: 'CLOCK',
          direction: 'IN',
          outcome: 'NOT_RECOGNISED',
          ...extra,
        },
      });

    it('are append-only, except that the retention sweep may clear the address', async () => {
      const row = await attempt({ clientAddress: '203.0.113.7', bestScore: 0.41 });
      await expect(
        prisma.clockInAttempt.update({ where: { id: row.id }, data: { outcome: 'MATCHED' } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.clockInAttempt.update({
          where: { id: row.id },
          data: { clientAddress: '198.51.100.1' },
        }),
      ).rejects.toThrow(/append-only/);
      await prisma.clockInAttempt.update({ where: { id: row.id }, data: { clientAddress: null } });
      await expect(prisma.clockInAttempt.delete({ where: { id: row.id } })).rejects.toThrow(
        /never deleted/,
      );
    });

    it('keep each kind of attempt in its own shape', async () => {
      // A button press is IN or OUT, never UNKNOWN.
      await expect(attempt({ direction: 'UNKNOWN' })).rejects.toThrow();
      // A face attempt never carries a typed staff number.
      await expect(attempt({ staffNumberTried: 'SMT-70001' })).rejects.toThrow();
      // "Not me" always points at the match it cancels, and a match names the person.
      await expect(attempt({ outcome: 'NOT_ME', employeeId: company.active.id })).rejects.toThrow();
      await expect(attempt({ outcome: 'MATCHED' })).rejects.toThrow();
      // The staff-number fallback only asks for a finger or is refused.
      await expect(
        attempt({ purpose: 'STAFF_PASSKEY', staffNumberTried: 'SMT-70001', outcome: 'MATCHED' }),
      ).rejects.toThrow();
      // Scores are between 0 and 1.
      await expect(attempt({ bestScore: 1.5 })).rejects.toThrow();

      const match = await attempt({ outcome: 'MATCHED', employeeId: company.active.id });
      const notMe = await attempt({
        outcome: 'NOT_ME',
        employeeId: company.active.id,
        cancelsAttemptId: match.id,
      });
      // One "Not me" per match.
      await expect(
        attempt({ outcome: 'NOT_ME', employeeId: company.active.id, cancelsAttemptId: match.id }),
      ).rejects.toThrow();
      expect(notMe.cancelsAttemptId).toBe(match.id);
    });

    it('keep a co-sign tied to the staff number typed and the worker it names', async () => {
      const coSign = {
        purpose: 'CO_SIGN',
        outcome: 'MATCHED',
        employeeId: company.supervisorEmployeeId,
      };
      // A co-sign always keeps the typed staff number, even one that matches nobody.
      await expect(attempt(coSign)).rejects.toThrow();
      await attempt({ ...coSign, staffNumberTried: 'SMT-99999' });
      const row = await attempt({
        ...coSign,
        staffNumberTried: company.active.staffNumber,
        coSignForEmployeeId: company.active.id,
      });
      expect(row.coSignForEmployeeId).toBe(company.active.id);
      // Only a co-sign names a worker it confirms.
      await expect(
        attempt({
          outcome: 'MATCHED',
          employeeId: company.active.id,
          coSignForEmployeeId: company.active.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe('devices', () => {
    it('give a serial number only to a terminal, and fingerprints only to a kiosk', async () => {
      await expect(
        prisma.device.update({ where: { id: kioskId }, data: { serialNumber: 'CKJ-1' } }),
      ).rejects.toThrow();
      await expect(
        prisma.device.update({ where: { id: terminalId }, data: { passkeysEnabled: true } }),
      ).rejects.toThrow();
      await prisma.device.update({ where: { id: terminalId }, data: { serialNumber: 'CKJ-1' } });
      await prisma.device.update({ where: { id: kioskId }, data: { passkeysEnabled: true } });
    });

    it('keep their company, site and kind for life (the routes a device may call depend on its kind)', async () => {
      await expect(
        prisma.device.update({ where: { id: faceOnlyKioskId }, data: { kind: 'ZKTECO' } }),
      ).rejects.toThrow(/for life/);
      await expect(
        prisma.device.update({ where: { id: terminalId }, data: { siteId: company.siteB } }),
      ).rejects.toThrow(/for life/);
    });
  });
});
