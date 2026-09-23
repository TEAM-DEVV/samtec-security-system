import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BiometricCollision,
  BiometricCollisionList,
  EmployeeBiometrics,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { EmployeeStatus } from '../../generated/prisma/enums.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type {
  BiometricReasonBody,
  ListCollisionsQuery,
  RequestExemptionBody,
  ResolveCollisionBody,
  ReviewExemptionBody,
} from './attendance.schemas.js';

/** What the face and the fingerprint keys of one worker look like from the dashboard. */
type FaceRow = Prisma.BiometricCredentialGetPayload<{ include: { device: true } }>;

/**
 * The dashboard side of biometrics (docs/plan/13-biometrics-design.md
 * section 2): what a worker's record looks like, the duplicate-enrollment
 * queue, and the actions that need a second ADMIN.
 *
 * The rules that matter most are about **who may decide**: never the person
 * whose own action is under review. The database enforces the same rules, so
 * a bug here cannot undo them.
 */
@Injectable()
export class BiometricReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  /** The Biometrics panel: status only, never a template, an embedding or a score. */
  async employeeBiometrics(viewer: SignedInUser, employeeId: string): Promise<EmployeeBiometrics> {
    // Reuses the workforce rules, so a supervisor sees only their own sites.
    await this.employees.get(viewer, employeeId);
    return this.panel(viewer, employeeId, this.prisma);
  }

  /**
   * Wipes a worker's face and switches off their fingerprint keys, for
   * example after enrolling the wrong person. It never settles a question a
   * second ADMIN owes an answer to.
   */
  async revoke(
    viewer: SignedInUser,
    employeeId: string,
    body: BiometricReasonBody,
  ): Promise<EmployeeBiometrics> {
    await this.employees.forBiometrics(viewer, employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, employeeId);
      await this.assertNothingOpen(tx, viewer.companyId, employeeId);
      const face = await liveFace(tx, viewer.companyId, employeeId);
      const keys = await liveKeys(tx, viewer.companyId, employeeId);
      if (!face && keys === 0) {
        throw new ConflictException('This worker has no face and no fingerprint keys to remove.');
      }
      await this.wipeEverything(tx, viewer, employeeId, 'REVOKED');
      await this.employees.clearBiometricsEnrolled(viewer.companyId, employeeId, tx);
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.revoked',
          entityType: 'employee',
          entityId: employeeId,
          // The reason stays on the audit row's action only: the free text
          // lives nowhere, like every other note in this project.
          detail: { hadFace: face !== null, revokedKeys: keys },
        },
        tx,
      );
      return this.panel(viewer, employeeId, tx);
    });
  }

  /**
   * The worker took their consent back. The face goes at once, as the law
   * requires, and the API files an exemption request in the ADMIN's name, so
   * a **second** ADMIN has to decide whether they may keep working.
   * Withdrawing never activates anybody.
   */
  async withdrawConsent(
    viewer: SignedInUser,
    employeeId: string,
    body: BiometricReasonBody,
  ): Promise<EmployeeBiometrics> {
    await this.employees.forBiometrics(viewer, employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, employeeId);
      const consent = await currentConsent(tx, viewer.companyId, employeeId);
      if (!consent) {
        throw new ConflictException('There is no consent to withdraw.');
      }
      const face = await liveFace(tx, viewer.companyId, employeeId);
      const wasInUse = face?.status === 'ACTIVE';
      await tx.biometricConsent.create({
        data: {
          companyId: viewer.companyId,
          employeeId,
          status: 'WITHDRAWN',
          textVersion: consent.textVersion,
          textSha256: consent.textSha256,
          recordedByUserId: viewer.userId,
        },
      });
      // A face waiting for review is wiped too, but its review stays open:
      // only a second ADMIN ever closes one.
      //
      // A worker with no face is already working without biometrics, by an
      // exemption two ADMINs agreed on. Taking their consent back changes
      // nothing about that, so it stays: one ADMIN must never be able to
      // undo what two of them decided.
      const status = face
        ? await this.wipeAndStandDown(tx, viewer, employeeId)
        : await this.employees.statusOf(viewer.companyId, employeeId, tx);

      // Only a worker who was really working by their face loses that
      // footing, so only then is a request filed for a second ADMIN.
      const filed =
        wasInUse && (await this.fileWithdrawalExemption(tx, viewer, employeeId, body.reason));
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.consent_withdrawn',
          entityType: 'employee',
          entityId: employeeId,
          detail: { filedExemption: filed === true, employeeStatus: status },
        },
        tx,
      );
      return this.panel(viewer, employeeId, tx);
    });
  }

  /** One ADMIN asks for a worker who refuses biometrics to work without them. */
  async requestExemption(
    viewer: SignedInUser,
    employeeId: string,
    body: RequestExemptionBody,
  ): Promise<EmployeeBiometrics> {
    await this.employees.forBiometrics(viewer, employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, employeeId);
      // Read the status again under the lock: an enrollment a moment ago may
      // have made this worker ACTIVE since the check above.
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { status: true },
      });
      if (employee.status !== 'PENDING_ENROLLMENT') {
        throw new ConflictException('Only a worker still waiting to be enrolled can be exempted.');
      }
      await this.assertNothingOpen(tx, viewer.companyId, employeeId);
      const anyFace = await tx.biometricCredential.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId,
          kind: 'FACE',
          status: { in: ['PENDING', 'ACTIVE'] },
        },
        select: { id: true },
      });
      if (anyFace) {
        throw new ConflictException(
          'This worker has a face on record. Remove it first if they no longer agree.',
        );
      }
      await tx.biometricExemption.create({
        data: {
          companyId: viewer.companyId,
          employeeId,
          reason: body.reason,
          note: body.note,
          requestedByUserId: viewer.userId,
        },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.exemption_requested',
          entityType: 'employee',
          entityId: employeeId,
          detail: { reason: body.reason },
        },
        tx,
      );
      return this.panel(viewer, employeeId, tx);
    });
  }

  /**
   * A **different** ADMIN decides it, after checking the worker's Ghana Card
   * in person: never the one who asked, and never anyone who enrolled or
   * wiped a face for this worker. Approving is what makes a worker without a
   * face `ACTIVE`, so it always takes two ADMIN accounts.
   */
  async reviewExemption(
    viewer: SignedInUser,
    employeeId: string,
    body: ReviewExemptionBody,
  ): Promise<EmployeeBiometrics> {
    await this.employees.forBiometrics(viewer, employeeId);
    return this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, employeeId);
      const waiting = await tx.biometricExemption.findFirst({
        where: { companyId: viewer.companyId, employeeId, status: 'REQUESTED' },
      });
      if (!waiting) {
        throw new ConflictException('There is no exemption request waiting for this worker.');
      }
      if (waiting.requestedByUserId === viewer.userId) {
        throw new ForbiddenException('The ADMIN who asked cannot decide their own request.');
      }
      // Whoever enrolled a face for this worker is out too: approving means
      // "this worker really cannot be enrolled", which is a judgement on the
      // enroller's own attempt (docs/plan/13 §2).
      const enrolled = await tx.biometricCredential.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId,
          kind: 'FACE',
          enrolledByUserId: viewer.userId,
        },
        select: { id: true },
      });
      if (enrolled) {
        throw new ForbiddenException(
          'You enrolled a face for this worker, so somebody else has to decide this.',
        );
      }
      await this.assertHandsOff(tx, viewer, [employeeId]);

      if (body.decision === 'REJECT') {
        await tx.biometricExemption.update({
          where: { id: waiting.id },
          data: this.decisionOf(viewer, 'REJECTED', body.note),
        });
      } else {
        // Inside the transaction, and under this worker's lock: approving is
        // what puts somebody to work, so it reads the newest status.
        const employee = await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
          select: { status: true },
        });
        if (employee.status !== 'PENDING_ENROLLMENT') {
          throw new ConflictException(
            'This worker is no longer waiting to be enrolled, so the request cannot be approved.',
          );
        }
        await tx.biometricExemption.update({
          where: { id: waiting.id },
          data: this.decisionOf(viewer, 'APPROVED', body.note),
        });
        await this.employees.activateWithoutBiometrics(viewer.companyId, employeeId, tx);
      }
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.exemption_reviewed',
          entityType: 'employee',
          entityId: employeeId,
          detail: { decision: body.decision, requestedByUserId: waiting.requestedByUserId },
        },
        tx,
      );
      return this.panel(viewer, employeeId, tx);
    });
  }

  /** The duplicate-enrollment queue, newest first. */
  async listCollisions(
    viewer: SignedInUser,
    query: ListCollisionsQuery,
  ): Promise<BiometricCollisionList> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === undefined) {
      throw fieldProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    }
    const open = (query.status ?? 'OPEN') === 'OPEN';
    const rows = await this.prisma.biometricCredential.findMany({
      where: {
        companyId: viewer.companyId,
        kind: 'FACE',
        dedupe: { in: open ? ['COLLISION'] : ['CLEARED', 'COLLISION'] },
        ...(open ? { verdict: null } : { verdict: { not: null } }),
        ...(after ? { enrolledAt: { lt: new Date(after) } } : {}),
      },
      orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { employee: true, lookalike: true },
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) =>
      row.enrolledAt.toISOString(),
    );
    return { items: pageRows.map(toApiCollision), nextCursor };
  }

  /**
   * A second ADMIN decides whether two faces are one person. For
   * `SAME_PERSON` the record that loses is blocked for good: its face is
   * wiped and blocked, its keys are revoked, its exemption ends, and it goes
   * back to waiting. The database checks the whole decision at commit.
   */
  async resolveCollision(
    viewer: SignedInUser,
    credentialId: string,
    body: ResolveCollisionBody,
  ): Promise<BiometricCollision> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.biometricCredential.findFirst({
        where: { id: credentialId, companyId: viewer.companyId, kind: 'FACE' },
        select: { employeeId: true, collisionEmployeeId: true },
      });
      if (!found || found.collisionEmployeeId === null) {
        throw new NotFoundException('No duplicate-enrollment review exists with this ID.');
      }
      const lookalikeId = found.collisionEmployeeId;
      // Both people's rows, in a fixed order, so two ADMINs deciding at the
      // same moment take turns instead of deadlocking (docs/plan/13 §2).
      await lockWorkers(tx, [found.employeeId, lookalikeId]);
      // Read it again now that the workers are ours: the other ADMIN may have
      // decided this very review while this request waited for the lock.
      const row = await tx.biometricCredential.findFirstOrThrow({
        where: { id: credentialId, companyId: viewer.companyId, kind: 'FACE' },
        include: { employee: true, lookalike: true },
      });
      if (row.verdict !== null) {
        throw new ConflictException('This review has already been decided.');
      }
      if (row.enrolledByUserId === viewer.userId) {
        throw new ForbiddenException('The ADMIN who enrolled this face cannot decide its review.');
      }
      await this.assertHandsOff(tx, viewer, [row.employeeId, lookalikeId]);

      const decision = this.decisionOf(viewer, null, body.note);
      if (body.verdict === 'DIFFERENT_PEOPLE') {
        await tx.biometricCredential.update({
          where: { id: credentialId },
          data: {
            dedupe: 'CLEARED',
            verdict: 'DIFFERENT_PEOPLE',
            resolutionNote: body.note,
            resolvedByUserId: viewer.userId,
            resolvedAt: decision.reviewedAt,
            // A face wiped in the meantime stays wiped: that worker enrolls
            // again or asks for an exemption.
            ...(row.wipedAt === null ? { status: 'ACTIVE' as const } : {}),
          },
        });
        if (row.wipedAt === null) {
          await this.faceIsInUse(tx, viewer, row.employeeId);
        }
      } else {
        if (body.keepEmployeeId !== row.employeeId && body.keepEmployeeId !== lookalikeId) {
          throw fieldProblem('keepEmployeeId', 'Keep one of the two records this review is about.');
        }
        const loserId = body.keepEmployeeId === row.employeeId ? lookalikeId : row.employeeId;
        const keepsNewFace = body.keepEmployeeId === row.employeeId;
        await tx.biometricCredential.update({
          where: { id: credentialId },
          data: {
            verdict: 'SAME_PERSON',
            keptEmployeeId: body.keepEmployeeId,
            resolutionNote: body.note,
            resolvedByUserId: viewer.userId,
            resolvedAt: decision.reviewedAt,
            ...(keepsNewFace
              ? row.wipedAt === null
                ? { dedupe: 'CLEARED' as const, status: 'ACTIVE' as const }
                : { dedupe: 'CLEARED' as const }
              : // A wipe is never re-signed: a face the sweep took (which
                // leaves nobody's name on it) keeps its own time and its
                // empty name, and only the status moves to BLOCKED.
                row.wipedAt === null
                ? {
                    status: 'BLOCKED' as const,
                    templateSealed: null,
                    keyVersion: null,
                    wipedAt: decision.reviewedAt,
                    wipedByUserId: viewer.userId,
                  }
                : { status: 'BLOCKED' as const }),
          },
        });
        if (keepsNewFace) {
          // The other record loses everything it had.
          await this.blockRecord(tx, viewer, loserId);
          if (row.wipedAt === null) {
            await this.faceIsInUse(tx, viewer, row.employeeId);
          }
        } else {
          // The new record was the duplicate: it keeps only its blocked face.
          await this.endExemptionsAndKeys(tx, viewer, row.employeeId);
          await this.employees.clearBiometricsEnrolled(viewer.companyId, row.employeeId, tx);
        }
      }

      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.collision_resolved',
          entityType: 'employee',
          entityId: row.employeeId,
          detail: {
            credentialId,
            verdict: body.verdict,
            lookedLikeEmployeeId: lookalikeId,
            ...(body.verdict === 'SAME_PERSON' ? { keptEmployeeId: body.keepEmployeeId } : {}),
          },
        },
        tx,
      );
      const decided = await tx.biometricCredential.findUniqueOrThrow({
        where: { id: credentialId },
        include: { employee: true, lookalike: true },
      });
      return toApiCollision(decided);
    });
  }

  /** Nothing new happens while a second ADMIN owes an answer. */
  private async assertNothingOpen(
    tx: TransactionClient,
    companyId: string,
    employeeId: string,
  ): Promise<void> {
    const [blocked, review, exemption] = await Promise.all([
      tx.biometricCredential.findFirst({
        where: { companyId, employeeId, kind: 'FACE', status: 'BLOCKED' },
        select: { id: true },
      }),
      // Open means "no verdict yet", not "the face is PENDING": the retention
      // sweep wipes a face that waited 90 days, and the question stays. A
      // review is about **two** records, so the worker the face looked like
      // is held as fast as the worker who enrolled it.
      tx.biometricCredential.findFirst({
        where: {
          companyId,
          kind: 'FACE',
          dedupe: 'COLLISION',
          verdict: null,
          OR: [{ employeeId }, { collisionEmployeeId: employeeId }],
        },
        select: { id: true },
      }),
      tx.biometricExemption.findFirst({ where: { companyId, employeeId, status: 'REQUESTED' } }),
    ]);
    if (blocked) {
      throw new ConflictException(
        'This record was blocked as a duplicate, so it can only be terminated.',
      );
    }
    if (review) {
      throw new ConflictException(
        'A second ADMIN has to finish the duplicate review for this worker first.',
      );
    }
    if (exemption) {
      throw new ConflictException(
        'A second ADMIN has to decide this worker’s exemption request first.',
      );
    }
  }

  /**
   * Nobody decides on their own action: whoever wiped a face for one of these
   * workers, or recorded their withdrawal, is out. Wiping a face is the step
   * an insider needs in order to reuse it, and it is rare in ordinary work,
   * so this seldom leaves nobody to decide (docs/plan/13 section 2).
   */
  private async assertHandsOff(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeIds: string[],
  ): Promise<void> {
    const [wiped, withdrew] = await Promise.all([
      tx.biometricCredential.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId: { in: employeeIds },
          wipedByUserId: viewer.userId,
        },
        select: { id: true },
      }),
      tx.biometricConsent.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId: { in: employeeIds },
          status: 'WITHDRAWN',
          recordedByUserId: viewer.userId,
        },
        select: { id: true },
      }),
    ]);
    if (wiped || withdrew) {
      throw new ForbiddenException(
        'You removed a face for one of these workers, so somebody else has to decide this.',
      );
    }
  }

  /** The fields every decision writes. */
  private decisionOf(viewer: SignedInUser, status: 'APPROVED' | 'REJECTED' | null, note: string) {
    const reviewedAt = new Date();
    return status === null
      ? { reviewedAt }
      : { status, reviewedAt, reviewedByUserId: viewer.userId, reviewNote: note };
  }

  /** Files the request a withdrawal leaves behind, unless one is already waiting. */
  private async fileWithdrawalExemption(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
    reason: string,
  ): Promise<boolean> {
    const open = await tx.biometricExemption.findFirst({
      where: { companyId: viewer.companyId, employeeId, status: { in: ['REQUESTED', 'APPROVED'] } },
    });
    if (open) {
      return false;
    }
    await tx.biometricExemption.create({
      data: {
        companyId: viewer.companyId,
        employeeId,
        reason: 'CONSENT_WITHDRAWN',
        note: reason,
        requestedByUserId: viewer.userId,
      },
    });
    return true;
  }

  /**
   * Wipes the face in use and switches off every fingerprint key.
   *
   * Blocking has one more step than revoking. A record is often blocked
   * **after** its face is already gone — a withdrawal of consent, or the
   * retention sweep, wipes a face while its review is still open, and the
   * design says the reviewer decides all the same. The record must still end
   * blocked, so the newest face of a record with nothing live is moved from
   * `REVOKED` to `BLOCKED`, keeping the original wipe untouched: a wipe is
   * never undone or re-signed (the database refuses that), and `BLOCKED` is
   * what stops this record for good.
   */
  private async wipeEverything(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
    to: 'REVOKED' | 'BLOCKED',
  ): Promise<void> {
    const face = await liveFace(tx, viewer.companyId, employeeId);
    if (face) {
      await tx.biometricCredential.update({
        where: { id: face.id },
        data: {
          status: to,
          templateSealed: null,
          keyVersion: null,
          wipedAt: new Date(),
          wipedByUserId: viewer.userId,
        },
      });
    } else if (to === 'BLOCKED') {
      const wiped = await tx.biometricCredential.findFirst({
        where: {
          companyId: viewer.companyId,
          employeeId,
          kind: 'FACE',
          status: { not: 'BLOCKED' },
        },
        orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (wiped) {
        await tx.biometricCredential.update({
          where: { id: wiped.id },
          data: { status: 'BLOCKED' },
        });
      }
    }
    await this.endExemptionsAndKeys(tx, viewer, employeeId);
  }

  /**
   * The worker's face is now the one they clock in with, so an exemption
   * they were working under is over — the same step enrolling a face that
   * passes takes. Nobody holds a face and an exemption at once.
   */
  private async faceIsInUse(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
  ): Promise<void> {
    await tx.biometricExemption.updateMany({
      where: { companyId: viewer.companyId, employeeId, status: 'APPROVED' },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    await this.employees.markBiometricsEnrolled(viewer.companyId, employeeId, tx);
  }

  /** Wipes what a worker had and takes them off the biometric footing. */
  private async wipeAndStandDown(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
  ): Promise<EmployeeStatus> {
    await this.wipeEverything(tx, viewer, employeeId, 'REVOKED');
    return this.employees.clearBiometricsEnrolled(viewer.companyId, employeeId, tx);
  }

  /** Switches off the fingerprint keys and ends an approved exemption. */
  private async endExemptionsAndKeys(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
  ): Promise<void> {
    await tx.devicePasskey.updateMany({
      where: { companyId: viewer.companyId, employeeId, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: viewer.userId },
    });
    await tx.biometricExemption.updateMany({
      where: { companyId: viewer.companyId, employeeId, status: { in: ['REQUESTED', 'APPROVED'] } },
      data: { status: 'ENDED', endedAt: new Date() },
    });
  }

  /**
   * Everything a record blocked as a duplicate loses.
   *
   * It blocks the **record**, not one particular capture: whatever face that
   * worker holds right now goes, along with their keys and any exemption.
   * That is the point of the decision — this employee record is a ghost — so
   * it stays right even if the worker enrolled again while the review waited.
   */
  private async blockRecord(
    tx: TransactionClient,
    viewer: SignedInUser,
    employeeId: string,
  ): Promise<void> {
    await this.wipeEverything(tx, viewer, employeeId, 'BLOCKED');
    await this.employees.clearBiometricsEnrolled(viewer.companyId, employeeId, tx);
  }

  /** Builds the panel from the rows as they stand. */
  private async panel(
    viewer: SignedInUser,
    employeeId: string,
    tx: TransactionClient,
  ): Promise<EmployeeBiometrics> {
    const [consent, face, keys, exemption] = await Promise.all([
      tx.biometricConsent.findFirst({
        where: { companyId: viewer.companyId, employeeId },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      }),
      tx.biometricCredential.findFirst({
        where: { companyId: viewer.companyId, employeeId, kind: 'FACE' },
        orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        include: { device: true },
      }),
      tx.devicePasskey.findMany({
        where: { companyId: viewer.companyId, employeeId },
        orderBy: [{ registeredAt: 'desc' }],
        include: { device: true },
      }),
      tx.biometricExemption.findFirst({
        where: { companyId: viewer.companyId, employeeId },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return {
      employeeId,
      consent: {
        status: consent?.status ?? 'WITHDRAWN',
        textVersion: consent?.textVersion ?? null,
        at: consent?.recordedAt.toISOString() ?? null,
      },
      face: {
        status: face ? face.status : 'NONE',
        dedupe: face?.dedupe ?? null,
        enrolledAt: face?.enrolledAt.toISOString() ?? null,
        deviceName: (face as FaceRow | null)?.device.name ?? null,
      },
      passkeys: keys.map((key) => ({
        id: key.id,
        deviceId: key.deviceId,
        deviceName: key.device.name,
        registeredAt: key.registeredAt.toISOString(),
        synced: key.backedUp,
        revokedAt: key.revokedAt?.toISOString() ?? null,
      })),
      exemption: exemption
        ? {
            status: exemption.status,
            reason: exemption.reason,
            // A supervisor sees the reason code, never the words.
            note: viewer.role === 'SUPERVISOR' ? null : exemption.note,
            requestedAt: exemption.requestedAt.toISOString(),
            requestedByUserId: exemption.requestedByUserId,
            reviewedAt: exemption.reviewedAt?.toISOString() ?? null,
            reviewedByUserId: exemption.reviewedByUserId,
          }
        : null,
    };
  }
}

type TransactionClient = Prisma.TransactionClient;

/** The worker's face in use, if there is one. */
async function liveFace(tx: TransactionClient, companyId: string, employeeId: string) {
  return tx.biometricCredential.findFirst({
    where: { companyId, employeeId, kind: 'FACE', wipedAt: null },
  });
}

/** How many fingerprint keys are still live. */
async function liveKeys(
  tx: TransactionClient,
  companyId: string,
  employeeId: string,
): Promise<number> {
  return tx.devicePasskey.count({ where: { companyId, employeeId, revokedAt: null } });
}

/** The worker's standing consent, if they have one. */
async function currentConsent(tx: TransactionClient, companyId: string, employeeId: string) {
  const latest = await tx.biometricConsent.findFirst({
    where: { companyId, employeeId },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
  });
  return latest?.status === 'GIVEN' ? latest : null;
}

/** Takes one worker's row for the rest of the transaction. */
async function lockWorker(tx: TransactionClient, employeeId: string): Promise<void> {
  await lockWorkers(tx, [employeeId]);
}

/** Takes several workers' rows, always in the same order, so nobody deadlocks. */
async function lockWorkers(tx: TransactionClient, employeeIds: string[]): Promise<void> {
  const ids = [...new Set(employeeIds)].sort();
  await tx.$queryRaw`SELECT 1 FROM employees WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
}

function toApiCollision(
  row: Prisma.BiometricCredentialGetPayload<{ include: { employee: true; lookalike: true } }>,
): BiometricCollision {
  const lookalike = row.lookalike;
  if (!lookalike || row.collisionSimilarity === null) {
    // Only a face that collided is ever in this list (a database CHECK).
    throw new NotFoundException('No duplicate-enrollment review exists with this ID.');
  }
  return {
    credentialId: row.id,
    status: row.verdict === null ? 'OPEN' : 'RESOLVED',
    employee: {
      id: row.employee.id,
      staffNumber: row.employee.staffNumber,
      fullName: `${row.employee.firstName} ${row.employee.lastName}`,
    },
    lookedLike: {
      id: lookalike.id,
      staffNumber: lookalike.staffNumber,
      fullName: `${lookalike.firstName} ${lookalike.lastName}`,
    },
    similarity: row.collisionSimilarity,
    enrolledAt: row.enrolledAt.toISOString(),
    enrolledByUserId: row.enrolledByUserId ?? '',
    deviceId: row.deviceId,
    resolution:
      row.verdict === null || row.resolvedAt === null || row.resolvedByUserId === null
        ? null
        : {
            verdict: row.verdict,
            keptEmployeeId: row.keptEmployeeId,
            note: row.resolutionNote ?? '',
            resolvedAt: row.resolvedAt.toISOString(),
            resolvedByUserId: row.resolvedByUserId,
          },
  };
}

/** A 400 that points at one request field, in the same shape as validation errors. */
function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}
