import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  BiometricConsent as ApiConsent,
  BiometricConsentText,
  FaceEnrollmentResult,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { newUuidV7 } from '../../common/ids.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { BiometricConsent, Prisma } from '../../generated/prisma/client.js';
import type { EmployeeStatus } from '../../generated/prisma/enums.js';
import { AuditService } from '../identity/audit.service.js';
import { SignInThrottleService } from '../identity/sign-in-throttle.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type { EnrollFaceBody, RecordConsentBody } from './attendance.schemas.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS as BIOMETRIC_TRANSACTION_OPTIONS,
  isLockTimeout,
  lockCompanyBiometrics,
} from './attendance-lock.js';
import { CONSENT_TEXT, CONSENT_TEXT_SHA256, CONSENT_TEXT_VERSION } from './consent-text.js';
import type { SignedDevice } from './device-signature.guard.js';
import type { FaceSample } from './face-match.js';
import { FaceProvider, type SealedFace } from './face-provider.js';

/**
 * What happens on the kiosk: consent, then the face
 * (docs/plan/13-biometrics-design.md section 2).
 *
 * Consent comes first, always — nothing about a worker's face may be
 * recorded before it — and every enrollment starts with the last 4 digits of
 * the Ghana Card the worker is holding, so the person being enrolled is the
 * person standing there.
 *
 * The dashboard side of biometrics (the duplicate review, revoke, withdrawal
 * and the exemption) lives in `biometric-reviews.service.ts`, and the 90-day
 * clean-up in `biometric-retention.service.ts`.
 */
@Injectable()
export class BiometricsService {
  private readonly logger = new Logger('Biometrics');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly throttle: SignInThrottleService,
    private readonly faces: FaceProvider,
  ) {}

  /** The one official wording, so the kiosk and the dashboard always agree. */
  consentText(): BiometricConsentText {
    return { version: CONSENT_TEXT_VERSION, text: CONSENT_TEXT, sha256: CONSENT_TEXT_SHA256 };
  }

  /**
   * Records that a worker agreed, on the kiosk in front of them. The ADMIN
   * first reads the last 4 digits off the worker's own Ghana Card, so the
   * person being enrolled is the person standing there.
   *
   * A worker who already agreed to these words gets that consent back, after
   * the card check: every enrollment starts with the card.
   */
  async recordConsent(
    caller: SignedInUser,
    device: SignedDevice,
    body: RecordConsentBody,
  ): Promise<{ consent: ApiConsent; created: boolean }> {
    if (body.textVersion !== CONSENT_TEXT_VERSION) {
      throw fieldProblem(
        'textVersion',
        `This kiosk is showing old wording. The current version is ${CONSENT_TEXT_VERSION}.`,
      );
    }
    const employee = await this.employees.forBiometrics(caller, body.employeeId);
    if (employee.status === 'TERMINATED') {
      throw new ConflictException('This worker has left, so nothing new can be recorded.');
    }

    await this.checkGhanaCard(caller, device, body);

    // Everything below happens one worker at a time (docs/plan/13 section 2):
    // two kiosks recording the same worker at the same moment would otherwise
    // both find no consent and both write one.
    const consent = await this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, body.employeeId);
      await this.assertNoOpenQuestion(tx, body.employeeId);
      const current = await this.currentConsent(body.employeeId, tx);
      if (current) {
        return { row: current, created: false };
      }
      const row = await tx.biometricConsent.create({
        data: {
          companyId: caller.companyId,
          employeeId: body.employeeId,
          status: 'GIVEN',
          textVersion: CONSENT_TEXT_VERSION,
          textSha256: CONSENT_TEXT_SHA256,
          recordedByUserId: caller.userId,
          deviceId: device.id,
        },
      });
      await this.audit.record(
        {
          companyId: caller.companyId,
          actorUserId: caller.userId,
          action: 'biometric.consent_recorded',
          entityType: 'employee',
          entityId: body.employeeId,
          detail: { deviceId: device.id, textVersion: CONSENT_TEXT_VERSION },
        },
        tx,
      );
      return { row, created: true };
    });
    return { consent: toApiConsent(consent.row), created: consent.created };
  }

  /**
   * Enrollment: three frames of one face, checked against everyone else in
   * the company, then stored as encrypted numbers (docs/plan/13 section 2).
   *
   * The whole thing is one transaction under the company's biometrics lock,
   * so two enrollments at the same moment take turns and each sees the
   * other's face. Punches never wait for it: they have a lock of their own.
   */
  async enrollFace(
    caller: SignedInUser,
    device: SignedDevice,
    body: EnrollFaceBody,
  ): Promise<FaceEnrollmentResult> {
    const sample = this.checkCapture(body.samples);
    const employee = await this.employees.forBiometrics(caller, body.employeeId);
    if (employee.status === 'TERMINATED') {
      throw new ConflictException('This worker has left, so nothing new can be recorded.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCompanyBiometrics(tx, caller.companyId);
        // The company's lock first, then this worker's row, always in that
        // order: it is the order the retention sweep takes them in too. The
        // worker's row is what an exemption request and a review also take,
        // so the open-question check below cannot be overtaken.
        await lockWorker(tx, body.employeeId);
        await this.assertNoOpenQuestion(tx, body.employeeId);
        const consent = await this.consentForEnrollment(tx, body);
        // Every unwiped face of everyone else in the company, whatever its
        // status: a ghost must not hide behind a face waiting for review.
        const others = await tx.biometricCredential.findMany({
          where: {
            companyId: caller.companyId,
            kind: 'FACE',
            wipedAt: null,
            employeeId: { not: body.employeeId },
          },
          select: {
            id: true,
            companyId: true,
            employeeId: true,
            keyVersion: true,
            templateSealed: true,
          },
        });
        const duplicate = this.faces.findDuplicate(sample, asSealedFaces(others), body.employeeId);
        if (duplicate.unreadable.length > 0) {
          // A face that cannot be opened is a face nobody compared against,
          // so the answer would be a guess. Refuse instead (docs/plan/13 §3).
          this.logger.error({
            reason: 'unreadable_faces',
            credentialIds: duplicate.unreadable,
            companyId: caller.companyId,
          });
          throw new BiometricsUnavailableException();
        }

        // One face at a time: the old one is wiped before the new one lands.
        await this.wipeLiveFace(tx, caller, body.employeeId, 'REVOKED');
        // The template is sealed to this row, so the id comes first.
        const credentialId = newUuidV7();
        const dedupe = duplicate.result ? 'COLLISION' : 'PASSED';
        await tx.biometricCredential.create({
          data: {
            id: credentialId,
            companyId: caller.companyId,
            employeeId: body.employeeId,
            kind: 'FACE',
            deviceId: device.id,
            templateSealed: new Uint8Array(
              this.faces.seal(sample.embedding, {
                companyId: caller.companyId,
                employeeId: body.employeeId,
                credentialId,
              }),
            ),
            keyVersion: this.faces.keyVersion,
            faceModel: this.faces.model,
            consentId: consent.id,
            enrolledByUserId: caller.userId,
            dedupe,
            status: dedupe === 'PASSED' ? 'ACTIVE' : 'PENDING',
            ...(duplicate.result
              ? {
                  collisionEmployeeId: duplicate.result.employeeId,
                  collisionSimilarity: duplicate.result.score,
                }
              : {}),
          },
        });

        // A face in use activates the worker and ends any exemption; a face
        // waiting for review leaves them pending, unpaid until it is settled.
        const employeeStatus =
          dedupe === 'PASSED'
            ? await this.facePassed(tx, caller, body.employeeId)
            : await this.employees.clearBiometricsEnrolled(caller.companyId, body.employeeId, tx);

        await this.audit.record(
          {
            companyId: caller.companyId,
            actorUserId: caller.userId,
            action: 'biometric.face_enrolled',
            entityType: 'employee',
            entityId: body.employeeId,
            detail: { credentialId, deviceId: device.id, dedupe },
          },
          tx,
        );
        return { credentialId, dedupe, employeeStatus };
      }, BIOMETRIC_TRANSACTION_OPTIONS);
    } catch (error) {
      throw isLockTimeout(error) ? new BiometricsBusyException() : error;
    }
  }

  /**
   * The three frames: each must look like a real, live face the server knows
   * how to read, and they must be the same person from start to finish.
   */
  private checkCapture(samples: FaceSample[]): FaceSample {
    samples.forEach((frame, index) => {
      const problem = this.faces.check(frame);
      if (problem === 'WRONG_MODEL' || problem === 'WRONG_SHAPE') {
        throw fieldProblem(
          `samples.${index}`,
          'This kiosk is sending face numbers this server cannot read.',
        );
      }
      if (problem === 'LOW_LIVENESS') {
        throw fieldProblem(`samples.${index}`, 'This frame did not look like a real, live face.');
      }
    });
    if (!this.faces.framesAgree(samples.map((frame) => frame.embedding))) {
      throw fieldProblem('samples', 'The three frames are not the same face. Capture again.');
    }
    // The last frame is the centred one the kiosk takes after the head turn.
    return samples[samples.length - 1] as FaceSample;
  }

  /** The consent this enrollment stands on: the worker's own, current, and the one the kiosk named. */
  private async consentForEnrollment(
    tx: TransactionClient,
    body: EnrollFaceBody,
  ): Promise<{ id: string }> {
    const current = await this.currentConsent(body.employeeId, tx);
    if (!current) {
      throw new ConflictException('This worker has not agreed to biometrics yet.');
    }
    if (current.id !== body.consentId) {
      throw fieldProblem('consentId', 'This is not the consent this worker just gave.');
    }
    return current;
  }

  /** A face that passed: the worker is enrolled, and any exemption is over. */
  private async facePassed(
    tx: TransactionClient,
    caller: SignedInUser,
    employeeId: string,
  ): Promise<EmployeeStatus> {
    await tx.biometricExemption.updateMany({
      where: { employeeId, status: 'APPROVED' },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    return this.employees.markBiometricsEnrolled(caller.companyId, employeeId, tx);
  }

  /**
   * Wipes the worker's face in use, if there is one: the numbers go, the row
   * stays as evidence. `BLOCKED` is for a proven duplicate and is final.
   */
  private async wipeLiveFace(
    tx: TransactionClient,
    caller: SignedInUser,
    employeeId: string,
    to: 'REVOKED' | 'BLOCKED',
  ): Promise<boolean> {
    const live = await tx.biometricCredential.findFirst({
      where: { employeeId, kind: 'FACE', wipedAt: null },
      select: { id: true },
    });
    if (!live) {
      return false;
    }
    await tx.biometricCredential.update({
      where: { id: live.id },
      data: {
        status: to,
        templateSealed: null,
        keyVersion: null,
        wipedAt: new Date(),
        wipedByUserId: caller.userId,
      },
    });
    return true;
  }

  /**
   * The card check, with its own patience: an attempt is taken before the
   * digits are looked at, so five wrong answers for one worker inside an hour
   * mean a wait even when they all arrive at once. A right answer wipes the
   * slate, so an honest ADMIN who mistypes is never stuck.
   */
  private async checkGhanaCard(
    caller: SignedInUser,
    device: SignedDevice,
    body: RecordConsentBody,
  ): Promise<void> {
    await this.throttle.claimAttempt('ghana-card', body.employeeId);
    const matches = await this.employees.ghanaCardLast4Matches(
      caller,
      body.employeeId,
      body.ghanaCardLast4,
    );
    if (matches) {
      await this.throttle.recordSuccess('ghana-card', body.employeeId);
      return;
    }
    // The digits themselves are never written down, here or in the log.
    await this.audit.record({
      companyId: caller.companyId,
      actorUserId: caller.userId,
      action: 'biometric.card_check_failed',
      entityType: 'employee',
      entityId: body.employeeId,
      detail: { deviceId: device.id },
    });
    throw fieldProblem(
      'ghanaCardLast4',
      'These are not the last 4 digits on this worker’s Ghana Card.',
    );
  }

  /**
   * One open question at a time (docs/plan/13 section 2): while a second
   * ADMIN still has to settle something, nothing new is recorded for this
   * worker. A record blocked as a duplicate is finished for good.
   *
   * Always called **after** the worker's row is locked, and with that same
   * transaction. Reading it outside the lock would let an ADMIN file an
   * exemption request in the moment between the check and the new row.
   */
  private async assertNoOpenQuestion(tx: TransactionClient, employeeId: string): Promise<void> {
    const [blocked, review, exemption] = await Promise.all([
      tx.biometricCredential.findFirst({
        where: { employeeId, kind: 'FACE', status: 'BLOCKED' },
        select: { id: true },
      }),
      // A review is open while it has no verdict — **not** while the face is
      // PENDING. After 90 days the retention sweep wipes such a face, which
      // makes it REVOKED, and the question it asks is still unanswered.
      tx.biometricCredential.findFirst({
        where: { employeeId, kind: 'FACE', dedupe: 'COLLISION', verdict: null },
        select: { id: true },
      }),
      tx.biometricExemption.findFirst({
        where: { employeeId, status: 'REQUESTED' },
        select: { id: true },
      }),
    ]);
    if (blocked) {
      throw new ConflictException(
        'This record was blocked as a duplicate, so nothing new can be recorded for it.',
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
   * The consent this worker is standing on right now: their latest row, and
   * only when it is a GIVEN one to exactly these words. A row with the same
   * version label but a different hash is not the same consent, so the worker
   * is asked again rather than told they already agreed.
   */
  private async currentConsent(
    employeeId: string,
    tx: TransactionClient,
  ): Promise<BiometricConsent | null> {
    const latest = await tx.biometricConsent.findFirst({
      where: { employeeId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    if (latest?.status !== 'GIVEN') {
      return null;
    }
    const sameWords =
      latest.textVersion === CONSENT_TEXT_VERSION && latest.textSha256 === CONSENT_TEXT_SHA256;
    return sameWords ? latest : null;
  }
}

/** The part of Prisma a transaction hands to this service. */
type TransactionClient = Prisma.TransactionClient;

/** The rows the matcher needs, straight from the database. */
function asSealedFaces(
  rows: Array<{
    id: string;
    companyId: string;
    employeeId: string;
    keyVersion: number | null;
    templateSealed: Uint8Array | null;
  }>,
): SealedFace[] {
  return rows.flatMap((row) =>
    row.templateSealed && row.keyVersion !== null
      ? [
          {
            credentialId: row.id,
            companyId: row.companyId,
            employeeId: row.employeeId,
            keyVersion: row.keyVersion,
            templateSealed: row.templateSealed,
          },
        ]
      : [],
  );
}

/** The answer while another enrollment in the same company holds the lock. */
export class BiometricsBusyException extends HttpException {
  readonly retryAfterSeconds = 5;

  constructor() {
    super(
      'Another enrollment for this company is in progress. Try again in a few seconds.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** The answer when a stored face cannot be opened, so nobody could be compared with it. */
export class BiometricsUnavailableException extends HttpException {
  readonly retryAfterSeconds = 5;

  constructor() {
    super(
      'The face check is unavailable: a stored face could not be read. An administrator has to look into it.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Takes the worker's row for the rest of the transaction, the way every
 * biometric write does (docs/plan/13 section 2). Everything else for this
 * worker waits, so two kiosks can never both decide there is no consent yet.
 */
async function lockWorker(tx: TransactionClient, employeeId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM employees WHERE id = ${employeeId}::uuid FOR NO KEY UPDATE`;
}

function toApiConsent(row: BiometricConsent): ApiConsent {
  return {
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    textVersion: row.textVersion,
    textSha256: row.textSha256,
    recordedAt: row.recordedAt.toISOString(),
    recordedByUserId: row.recordedByUserId,
    deviceId: row.deviceId,
  };
}

/** A 400 that points at one request field, in the same shape as validation errors. */
function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}

/** Kept for the controller's 404 wording to stay in one place. */
export const NO_SUCH_EMPLOYEE = new NotFoundException('No employee exists with this ID.');
