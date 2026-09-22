import { randomUUID } from 'node:crypto';
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
  /** A second company, for the rule that every row stays inside one company. */
  let other: AttendanceCompany;
  let kioskId = '';
  let faceOnlyKioskId = '';
  let terminalId = '';
  let simulatorId = '';
  let otherKioskId = '';

  const device = (
    name: string,
    kind: 'FACE_KIOSK' | 'ZKTECO' | 'MOCK',
    passkeysEnabled = false,
    owner: AttendanceCompany = company,
  ) =>
    prisma.device.create({
      data: {
        companyId: owner.companyId,
        siteId: owner.siteA,
        name,
        kind,
        passkeysEnabled,
        secretEncrypted: 'v1$not$a$secret',
      },
    });

  beforeAll(async () => {
    prisma = openFixtureDb(databaseUrl as string);
    company = await createAttendanceCompany(prisma);
    other = await createAttendanceCompany(prisma);
    // Fingerprint keys may only be saved on a kiosk with fingerprints switched on.
    kioskId = (await device('Rules kiosk', 'FACE_KIOSK', true)).id;
    faceOnlyKioskId = (await device('Rules face-only kiosk', 'FACE_KIOSK')).id;
    terminalId = (await device('Rules terminal', 'ZKTECO')).id;
    simulatorId = (await device('Rules simulator', 'MOCK')).id;
    otherKioskId = (await device('Other company kiosk', 'FACE_KIOSK', true, other)).id;
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
  const faceWithConsent = (
    employeeId: string,
    consentId: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.biometricCredential.create({
      data: {
        companyId: company.companyId,
        employeeId,
        kind: 'FACE',
        deviceId: kioskId,
        templateSealed: TEMPLATE,
        keyVersion: 1,
        faceModel: 'human-faceres-1',
        consentId,
        enrolledByUserId: ENROLLER,
        dedupe: 'PASSED',
        status: 'ACTIVE',
        ...extra,
      },
    });

  /** The same, after recording the worker's consent first. */
  const face = async (employeeId: string, extra: Record<string, unknown> = {}) =>
    faceWithConsent(employeeId, (await consent(employeeId)).id, extra);

  /** A finger a ZKTeco terminal reported. */
  const finger = (employeeId: string, deviceId = terminalId, extra: Record<string, unknown> = {}) =>
    prisma.biometricCredential.create({
      data: {
        companyId: company.companyId,
        employeeId,
        kind: 'TERMINAL_FINGER',
        deviceId,
        dedupe: 'NOT_CHECKED',
        status: 'ACTIVE',
        ...extra,
      },
    });

  /**
   * A fingerprint key. Key IDs are unique across the whole database and rows
   * are never deleted, so each run uses its own (the company ID is new every run).
   */
  const key = (employeeId: string, name: string, deviceId = kioskId) =>
    prisma.devicePasskey.create({
      data: {
        companyId: company.companyId,
        employeeId,
        deviceId,
        credentialId: `${name}-${company.companyId}`,
        publicKey: new Uint8Array([1, 2, 3]),
        backedUp: false,
        registeredByUserId: ENROLLER,
      },
    });

  /** A waiting request to work without biometrics. */
  const exemptionRequest = (employeeId: string, by = ENROLLER) =>
    prisma.biometricExemption.create({
      data: {
        companyId: company.companyId,
        employeeId,
        reason: 'DECLINED',
        note: 'Declined in writing.',
        requestedByUserId: by,
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

  /** Any client that can write credentials: the plain one, or one inside a transaction. */
  type Db = Pick<PrismaClient, 'biometricCredential'>;

  /** A second ADMIN keeps the new record, whose face collided, as the real one... */
  const keepNewRecord = (newFaceId: string, keptId: string, db: Db = prisma) =>
    db.biometricCredential.update({
      where: { id: newFaceId },
      data: {
        ...decision('SAME_PERSON'),
        keptEmployeeId: keptId,
        dedupe: 'CLEARED',
        status: 'ACTIVE',
      },
    });

  /** ...and the older record's face is blocked. */
  const blockFace = (faceId: string, db: Db = prisma) =>
    db.biometricCredential.update({ where: { id: faceId }, data: { ...wiped, status: 'BLOCKED' } });

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
      // CASCADE also reaches the faces that point at consents; the message
      // shows it was the consents' own trigger that refused.
      await expect(prisma.$executeRawUnsafe('TRUNCATE biometric_consents CASCADE')).rejects.toThrow(
        /biometric_consents is append-only/,
      );
    });

    it("are given on one of the company's kiosks, and record the SHA-256 of the exact text", async () => {
      const base = {
        companyId: company.companyId,
        employeeId: company.active.id,
        textVersion: 'bio-v1',
        recordedByUserId: ENROLLER,
      };
      const given = (deviceId: string | null, textSha256 = SHA256) =>
        prisma.biometricConsent.create({
          data: { ...base, status: 'GIVEN', textSha256, deviceId },
        });
      // (The insert trigger runs before the CHECK, so it refuses a missing device first.)
      await expect(given(null)).rejects.toThrow(/consent is given on a face kiosk/);
      await expect(given(kioskId, 'not-a-hash')).rejects.toThrow(/biometric_consents_values_valid/);
      await expect(given(terminalId)).rejects.toThrow(/consent is given on a face kiosk/);
      await expect(given(otherKioskId)).rejects.toThrow(/face kiosk of the same company/);
      // A withdrawal may be recorded on the dashboard (no device), or on one
      // of the company's kiosks, but never on a terminal or another company's kiosk.
      const withdrawn = (deviceId: string | null) =>
        prisma.biometricConsent.create({
          data: { ...base, status: 'WITHDRAWN', textSha256: SHA256, deviceId },
        });
      await withdrawn(null);
      await withdrawn(kioskId);
      const elsewhere = /a withdrawal is recorded on the dashboard or on a face kiosk/;
      await expect(withdrawn(terminalId)).rejects.toThrow(elsewhere);
      await expect(withdrawn(otherKioskId)).rejects.toThrow(elsewhere);
    });

    it("stay inside the worker's company, and the database sets the time", async () => {
      await expect(
        prisma.biometricConsent.create({
          data: {
            companyId: other.companyId,
            employeeId: company.active.id,
            status: 'WITHDRAWN',
            textVersion: 'bio-v1',
            textSha256: SHA256,
            recordedByUserId: ENROLLER,
          },
        }),
      ).rejects.toThrow(/belongs to another company/);
      // A time sent by the caller is replaced by the database's own clock, so
      // a consent can never be dated after its withdrawal.
      const row = await prisma.biometricConsent.create({
        data: {
          companyId: company.companyId,
          employeeId: company.active.id,
          status: 'GIVEN',
          textVersion: 'bio-v1',
          textSha256: SHA256,
          recordedByUserId: ENROLLER,
          deviceId: kioskId,
          recordedAt: new Date('2099-01-01T00:00:00Z'),
        },
      });
      expect(Math.abs(row.recordedAt.getTime() - Date.now())).toBeLessThan(60_000);
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
      await expect(
        face(company.supervisorEmployeeId, { templateSealed: null, keyVersion: null }),
      ).rejects.toThrow(/biometric_credentials_shape/);
      await expect(face(company.supervisorEmployeeId, { keyVersion: null })).rejects.toThrow(
        /biometric_credentials_template_key/,
      );
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

    it('change a template only when it is sealed again with a newer key (key rotation)', async () => {
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
      // The key version never moves on its own: lowering it first, then
      // "re-sealing" with the old number, would swap the template.
      for (const keyVersion of [1, 3]) {
        await expect(
          prisma.biometricCredential.update({ where: { id: row.id }, data: { keyVersion } }),
        ).rejects.toThrow(/newer key/);
      }
    });

    it('are never deleted or truncated', async () => {
      const row = await prisma.biometricCredential.findFirstOrThrow({
        where: { companyId: company.companyId },
      });
      await expect(prisma.biometricCredential.delete({ where: { id: row.id } })).rejects.toThrow(
        /never deleted/,
      );
      await expect(prisma.$executeRawUnsafe('TRUNCATE biometric_credentials')).rejects.toThrow(
        /biometric_credentials rows are never deleted/,
      );
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
          data: {
            ...decision('DIFFERENT_PEOPLE'),
            resolutionNote: null,
            dedupe: 'CLEARED',
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow(/biometric_credentials_decision_valid/);
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

      // The decision alone would leave the ghost clocking in; a block alone has no decision.
      await expect(keepNewRecord(guardFace.id, guard.id)).rejects.toThrow(
        /must block the other record/,
      );
      await expect(blockFace(ghostFace.id)).rejects.toThrow(
        /blocked only by a SAME_PERSON decision/,
      );
      // Together, in one transaction, both hold.
      await prisma.$transaction([keepNewRecord(guardFace.id, guard.id), blockFace(ghostFace.id)]);
      await expect(
        prisma.biometricCredential.update({
          where: { id: ghostFace.id },
          data: { status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/can never become/);
    });

    it('take everything from the record that lost: its face blocked, its keys revoked, its exemption ended', async () => {
      const ghost = await newStarter();
      const ghostFace = await face(ghost.id);
      const ghostKey = await key(ghost.id, 'key-ghost');
      const ghostRequest = await exemptionRequest(ghost.id);
      const guard = await newStarter();
      const guardFace = await collision(guard.id, ghost.id);
      const decide = () => keepNewRecord(guardFace.id, guard.id);
      const revokeKey = () =>
        prisma.devicePasskey.update({
          where: { id: ghostKey.id },
          data: { revokedAt: new Date(), revokedByUserId: REVIEWER },
        });
      const endRequest = () =>
        prisma.biometricExemption.update({
          where: { id: ghostRequest.id },
          data: { status: 'ENDED', endedAt: new Date() },
        });
      const mustBlock = /must block the other record/;

      // A live key, or an exemption still waiting, would let the ghost clock in.
      await expect(prisma.$transaction([decide(), blockFace(ghostFace.id)])).rejects.toThrow(
        mustBlock,
      );
      await expect(
        prisma.$transaction([decide(), blockFace(ghostFace.id), revokeKey()]),
      ).rejects.toThrow(mustBlock);
      await expect(
        prisma.$transaction([decide(), blockFace(ghostFace.id), endRequest()]),
      ).rejects.toThrow(mustBlock);
      // A face merely revoked (not BLOCKED) would let the record enroll again.
      await expect(
        prisma.$transaction([
          decide(),
          prisma.biometricCredential.update({
            where: { id: ghostFace.id },
            data: { ...wiped, status: 'REVOKED' },
          }),
          revokeKey(),
          endRequest(),
        ]),
      ).rejects.toThrow(mustBlock);
      await prisma.$transaction([decide(), blockFace(ghostFace.id), revokeKey(), endRequest()]);
    });

    it('keep a look-alike only on a face that collided', async () => {
      const lookalike = await newStarter();
      // A face that passed, or a finger, never names a look-alike: otherwise a
      // SAME_PERSON verdict could block a record that never collided.
      await expect(
        face((await newStarter()).id, { collisionEmployeeId: lookalike.id }),
      ).rejects.toThrow(/biometric_credentials_collision_evidence/);
      await expect(
        finger((await newStarter()).id, terminalId, { collisionEmployeeId: lookalike.id }),
      ).rejects.toThrow(/biometric_credentials_collision_evidence/);
      // Only someone in the same company.
      await expect(collision((await newStarter()).id, other.active.id)).rejects.toThrow(
        /looks like someone in the same company/,
      );
    });

    it('never decide one pair of records two ways', async () => {
      // Two new faces that each look like the other: the first decision blocks
      // the second face, whose own review then closes with it.
      const first = await newStarter();
      const second = await newStarter();
      const firstFace = await collision(first.id, second.id);
      const secondFace = await collision(second.id, first.id);
      await prisma.$transaction([keepNewRecord(firstFace.id, first.id), blockFace(secondFace.id)]);
      await expect(
        prisma.biometricCredential.update({
          where: { id: secondFace.id },
          data: { ...decision('DIFFERENT_PEOPLE'), dedupe: 'CLEARED' },
        }),
      ).rejects.toThrow(/a blocked face is never decided/);

      // The other order: "different people" first, then "the same person".
      const third = await newStarter();
      const fourth = await newStarter();
      const thirdFace = await collision(third.id, fourth.id);
      const fourthFace = await collision(fourth.id, third.id);
      await prisma.biometricCredential.update({
        where: { id: fourthFace.id },
        data: { ...decision('DIFFERENT_PEOPLE'), dedupe: 'CLEARED', status: 'ACTIVE' },
      });
      await expect(
        prisma.$transaction([keepNewRecord(thirdFace.id, third.id), blockFace(fourthFace.id)]),
      ).rejects.toThrow(/never decided two ways/);
      // A decision that agrees is fine.
      await prisma.biometricCredential.update({
        where: { id: thirdFace.id },
        data: { ...decision('DIFFERENT_PEOPLE'), dedupe: 'CLEARED', status: 'ACTIVE' },
      });
    });

    it('let a later copy of a blocked record be blocked too', async () => {
      // One real guard and two ghosts with the same face. Both ghost reviews
      // are open when the guard enrolls (a new face is only ever compared with
      // faces in use). His review blocks the first ghost, and the second
      // review then keeps that blocked record, blocking the second ghost too.
      const ghost = await newStarter();
      const ghostFace = await face(ghost.id);
      const secondGhost = await newStarter();
      const secondGhostFace = await collision(secondGhost.id, ghost.id);
      const guard = await newStarter();
      const guardFace = await collision(guard.id, ghost.id);
      await prisma.$transaction([keepNewRecord(guardFace.id, guard.id), blockFace(ghostFace.id)]);
      await prisma.biometricCredential.update({
        where: { id: secondGhostFace.id },
        data: { ...decision('SAME_PERSON'), keptEmployeeId: ghost.id, ...wiped, status: 'BLOCKED' },
      });
      const second = await prisma.biometricCredential.findUniqueOrThrow({
        where: { id: secondGhostFace.id },
      });
      expect(second.status).toBe('BLOCKED');
      expect(second.keptEmployeeId).toBe(ghost.id);
      const older = await prisma.biometricCredential.findUniqueOrThrow({
        where: { id: ghostFace.id },
      });
      expect(older.status).toBe('BLOCKED');
      expect(older.verdict).toBeNull();
    });
  });

  describe('one worker at a time', () => {
    /** Waits (up to 3 seconds) until another connection is stuck waiting for a lock on `table`. */
    const waitingOn = async (table: string) => {
      for (let tries = 0; tries < 60; tries += 1) {
        const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE ${`%${table}%`}`;
        if (row && row.waiting > 0n) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`nothing waited on ${table}`);
    };

    /** Runs `first` in a transaction and keeps it open until `second` is waiting for it. */
    const whileOpen = async <T>(
      first: (tx: Db & Pick<PrismaClient, 'devicePasskey'>) => Promise<unknown>,
      second: () => Promise<T>,
      waitTable: string,
    ) => {
      let release = () => {};
      let started = () => {};
      const isStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = prisma.$transaction(
        async (tx) => {
          await first(tx);
          started();
          await released;
        },
        { timeout: 15_000 },
      );
      // `open` settles first only when `first` failed; the race then throws its error.
      await Promise.race([isStarted, open]);
      const late = second().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await waitingOn(waitTable);
      } catch (error) {
        // Always end the open transaction, so a failure never leaves its locks
        // behind, and say what the other statement did instead of waiting.
        release();
        await open.catch(() => undefined);
        const other = await late;
        const did = other.ok ? 'went straight through' : `failed: ${String(other.error)}`;
        throw new Error(`${(error as Error).message}; the other statement ${did}`);
      }
      release();
      await open;
      return late;
    };

    const RACE_TIMEOUT = 15_000;

    it(
      'refuse a new key that waited for a block of the same record',
      async () => {
        const ghost = await newStarter();
        const ghostFace = await face(ghost.id);
        const guard = await newStarter();
        const guardFace = await collision(guard.id, ghost.id);

        const late = await whileOpen(
          async (tx) => {
            await keepNewRecord(guardFace.id, guard.id, tx);
            await blockFace(ghostFace.id, tx);
          },
          () => key(ghost.id, 'key-race-late'),
          'device_passkeys',
        );
        expect(late.ok).toBe(false);
        expect(String(!late.ok && late.error)).toMatch(/device_passkeys: a record blocked/);
      },
      RACE_TIMEOUT,
    );

    it(
      'refuse a block that waited for a new key of the same record',
      async () => {
        const ghost = await newStarter();
        const ghostFace = await face(ghost.id);
        const guard = await newStarter();
        const guardFace = await collision(guard.id, ghost.id);

        const late = await whileOpen(
          (tx) =>
            tx.devicePasskey.create({
              data: {
                companyId: company.companyId,
                employeeId: ghost.id,
                deviceId: kioskId,
                credentialId: `key-race-first-${company.companyId}`,
                publicKey: new Uint8Array([1]),
                backedUp: false,
                registeredByUserId: ENROLLER,
              },
            }),
          () =>
            prisma.$transaction([keepNewRecord(guardFace.id, guard.id), blockFace(ghostFace.id)]),
          'biometric_credentials',
        );
        expect(late.ok).toBe(false);
        expect(String(!late.ok && late.error)).toMatch(/must block the other record/);
      },
      RACE_TIMEOUT,
    );

    it(
      'make a "different people" decision wait for both records too',
      async () => {
        // Every decision takes the lock, not only one that blocks a record, so
        // two ADMINs can never decide one pair two ways without seeing each other.
        const lookalike = await newStarter();
        await face(lookalike.id);
        const worker = await newStarter();
        const workerFace = await collision(worker.id, lookalike.id);

        const late = await whileOpen(
          (tx) =>
            tx.biometricCredential.update({
              where: { id: workerFace.id },
              data: { ...decision('DIFFERENT_PEOPLE'), dedupe: 'CLEARED', status: 'ACTIVE' },
            }),
          () => key(lookalike.id, 'key-race-lookalike'),
          'device_passkeys',
        );
        // The key waited for the decision, and is saved once that is in.
        expect(late.ok).toBe(true);
      },
      RACE_TIMEOUT,
    );
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

    it("belong on the right kind of device, in the worker's company", async () => {
      await expect(face((await newStarter()).id, { deviceId: terminalId })).rejects.toThrow(
        /enrolled on a face kiosk/,
      );
      await expect(face((await newStarter()).id, { deviceId: otherKioskId })).rejects.toThrow(
        /face kiosk of the same company/,
      );
      // A finger only comes from a ZKTeco terminal: never a kiosk or a simulator.
      const fromTerminal = /comes from a ZKTeco terminal/;
      await expect(finger((await newStarter()).id, kioskId)).rejects.toThrow(fromTerminal);
      await expect(finger((await newStarter()).id, simulatorId)).rejects.toThrow(fromTerminal);
      await finger((await newStarter()).id);
      // Nor for a worker of another company.
      await expect(finger(other.active.id)).rejects.toThrow(/belongs to another company/);
    });

    it("use this worker's own consent, given and not withdrawn since", async () => {
      const first = await newStarter();
      const second = await newStarter();
      const firstConsent = await consent(first.id);
      const notStanding = /own, given and not withdrawn/;
      await expect(face(second.id, { consentId: firstConsent.id })).rejects.toThrow(notStanding);
      const withdrawal = (employeeId: string) =>
        prisma.biometricConsent.create({
          data: {
            companyId: company.companyId,
            employeeId,
            status: 'WITHDRAWN',
            textVersion: 'bio-v1',
            textSha256: SHA256,
            recordedByUserId: ENROLLER,
          },
        });
      await withdrawal(first.id);
      await expect(face(first.id, { consentId: firstConsent.id })).rejects.toThrow(notStanding);
      // A consent and a withdrawal saved in the same millisecond count as
      // withdrawn. One statement writes both, repeated until the database
      // gives them the same time (almost always the first try).
      const third = await newStarter();
      let tied: string | undefined;
      for (let tries = 0; tries < 20 && !tied; tries += 1) {
        const rows = await prisma.$queryRaw<{ id: string; status: string; recorded_at: Date }[]>`
          INSERT INTO biometric_consents
            (id, company_id, employee_id, status, text_version, text_sha256, recorded_by_user_id, device_id)
          VALUES
            (${randomUUID()}::uuid, ${company.companyId}::uuid, ${third.id}::uuid, 'GIVEN',
             'bio-v1', ${SHA256}, ${ENROLLER}::uuid, ${kioskId}::uuid),
            (${randomUUID()}::uuid, ${company.companyId}::uuid, ${third.id}::uuid, 'WITHDRAWN',
             'bio-v1', ${SHA256}, ${ENROLLER}::uuid, NULL)
          RETURNING id, status::text AS status, recorded_at`;
        const given = rows.find((row) => row.status === 'GIVEN');
        const withdrawn = rows.find((row) => row.status === 'WITHDRAWN');
        if (given && withdrawn && given.recorded_at.getTime() === withdrawn.recorded_at.getTime()) {
          tied = given.id;
        }
      }
      expect(tied).toBeDefined();
      await expect(faceWithConsent(third.id, tied as string)).rejects.toThrow(notStanding);
    });

    it('give nothing live to a record blocked as a duplicate', async () => {
      // The leaver's record lost a SAME_PERSON decision above.
      const blocked = company.leaver.id;
      const standing = await prisma.biometricConsent.findFirstOrThrow({
        where: { employeeId: blocked, status: 'GIVEN' },
      });
      await expect(consent(blocked)).rejects.toThrow(/biometric_consents: a record blocked/);
      await expect(faceWithConsent(blocked, standing.id)).rejects.toThrow(
        /biometric_credentials: a record blocked/,
      );
      await expect(finger(blocked)).rejects.toThrow(/biometric_credentials: a record blocked/);
      await expect(exemptionRequest(blocked)).rejects.toThrow(
        /biometric_exemptions: a record blocked/,
      );
      await expect(key(blocked, 'key-blocked')).rejects.toThrow(
        /device_passkeys: a record blocked/,
      );
      // A finger a terminal reported for it anyway is kept, BLOCKED, as evidence...
      await finger(blocked, terminalId, { status: 'BLOCKED', wipedAt: new Date() });
      // ...and a withdrawal of consent is still recorded, as the law requires.
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
    const review = (by: string, status: 'APPROVED' | 'REJECTED' = 'APPROVED') => ({
      status,
      reviewedByUserId: by,
      reviewedAt: new Date(),
      reviewNote: 'Ghana Card checked in person.',
    });

    it('are never decided by the ADMIN who asked', async () => {
      const row = await exemptionRequest(company.active.id);
      await expect(
        prisma.biometricExemption.update({ where: { id: row.id }, data: review(ENROLLER) }),
      ).rejects.toThrow();
      await prisma.biometricExemption.update({ where: { id: row.id }, data: review(REVIEWER) });
    });

    it('allow one request waiting or approved per employee', async () => {
      await expect(exemptionRequest(company.active.id)).rejects.toThrow();
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
      await exemptionRequest(company.active.id);
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
      await expect(prisma.$executeRawUnsafe('TRUNCATE biometric_exemptions')).rejects.toThrow(
        /biometric_exemptions rows are never deleted/,
      );
    });

    it('take a decision only on a waiting request, in one step', async () => {
      // A request that ended undecided can never be given a decision afterwards...
      const ended = await exemptionRequest((await newStarter()).id);
      await prisma.biometricExemption.update({
        where: { id: ended.id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      const { status: _approved, ...decisionOnly } = review(REVIEWER);
      await expect(
        prisma.biometricExemption.update({ where: { id: ended.id }, data: decisionOnly }),
      ).rejects.toThrow(/only on a waiting request/);
      // ...and a waiting request cannot end with a decision attached.
      const waiting = await exemptionRequest((await newStarter()).id);
      await expect(
        prisma.biometricExemption.update({
          where: { id: waiting.id },
          data: { ...review(REVIEWER), status: 'ENDED', endedAt: new Date() },
        }),
      ).rejects.toThrow(/only on a waiting request/);
    });
  });

  describe('fingerprint keys', () => {
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
      await expect(prisma.$executeRawUnsafe('TRUNCATE device_passkeys')).rejects.toThrow(
        /device_passkeys rows are never deleted/,
      );
    });

    it("are saved only on one of the company's kiosks with fingerprints switched on", async () => {
      const worker = (await newStarter()).id;
      const refused = /kiosk of the same company with fingerprints switched on/;
      await expect(key(worker, 'key-terminal', terminalId)).rejects.toThrow(refused);
      await expect(key(worker, 'key-face-only', faceOnlyKioskId)).rejects.toThrow(refused);
      await expect(key(worker, 'key-other-company', otherKioskId)).rejects.toThrow(refused);
    });

    it("refuse switching a kiosk's fingerprints off until every key on it is revoked", async () => {
      const kiosk = (await device('Switch-off kiosk', 'FACE_KIOSK', true)).id;
      const live = await key((await newStarter()).id, 'key-switch-off', kiosk);
      const switchOff = () =>
        prisma.device.update({ where: { id: kiosk }, data: { passkeysEnabled: false } });
      // Switching off while a key is still live is refused when it is saved...
      await expect(switchOff()).rejects.toThrow(
        /only in the same transaction that revokes every key/,
      );
      // ...and allowed with the revoke in the same transaction.
      await prisma.$transaction([
        switchOff(),
        prisma.devicePasskey.update({
          where: { id: live.id },
          data: { revokedAt: new Date(), revokedByUserId: REVIEWER },
        }),
      ]);
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
      await expect(prisma.$executeRawUnsafe('TRUNCATE clock_in_attempts')).rejects.toThrow(
        /clock_in_attempts rows are never deleted/,
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
      await prisma.device.update({
        where: { id: faceOnlyKioskId },
        data: { passkeysEnabled: true },
      });
      await prisma.device.update({
        where: { id: faceOnlyKioskId },
        data: { passkeysEnabled: false },
      });
    });

    it('keep their company, site and kind for life (the routes a device may call depend on its kind)', async () => {
      await expect(
        prisma.device.update({ where: { id: faceOnlyKioskId }, data: { kind: 'ZKTECO' } }),
      ).rejects.toThrow(/for life/);
      await expect(
        prisma.device.update({ where: { id: terminalId }, data: { siteId: company.siteB } }),
      ).rejects.toThrow(/for life/);
      await expect(
        prisma.device.update({ where: { id: terminalId }, data: { companyId: other.companyId } }),
      ).rejects.toThrow(/for life/);
    });
  });
});
