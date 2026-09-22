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
  let terminalId = '';

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    const device = (name: string, kind: 'FACE_KIOSK' | 'ZKTECO') =>
      prisma.device.create({
        data: {
          companyId: company.companyId,
          siteId: company.siteA,
          name,
          kind,
          secretEncrypted: 'v1$not$a$secret',
        },
      });
    kioskId = (await device('Rules kiosk', 'FACE_KIOSK')).id;
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
  });
});
