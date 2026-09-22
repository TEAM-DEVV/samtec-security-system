import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BiometricConsent as ApiConsent, BiometricConsentText } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { BiometricConsent } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { SignInThrottleService } from '../identity/sign-in-throttle.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type { RecordConsentBody } from './attendance.schemas.js';
import { CONSENT_TEXT, CONSENT_TEXT_SHA256, CONSENT_TEXT_VERSION } from './consent-text.js';
import type { SignedDevice } from './device-signature.guard.js';

/**
 * Consent, the first step of enrollment (docs/plan/13-biometrics-design.md
 * section 2). Nothing about a worker's face may be recorded before this.
 *
 * The rest of enrollment — the capture, the duplicate check, the review, the
 * exemption and the retention sweep — follows in the next pull request.
 */
@Injectable()
export class BiometricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly throttle: SignInThrottleService,
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
    await this.assertNoOpenQuestion(body.employeeId);

    const current = await this.currentConsent(body.employeeId);
    if (current && current.textVersion === CONSENT_TEXT_VERSION) {
      return { consent: toApiConsent(current), created: false };
    }

    const consent = await this.prisma.$transaction(async (tx) => {
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
      return row;
    });
    return { consent: toApiConsent(consent), created: true };
  }

  /**
   * The card check, with its own patience: five wrong answers for one worker
   * within an hour and that worker waits for the rest of the hour, so nobody
   * can sit at a kiosk trying digits.
   */
  private async checkGhanaCard(
    caller: SignedInUser,
    device: SignedDevice,
    body: RecordConsentBody,
  ): Promise<void> {
    await this.throttle.assertNotLocked('ghana-card', body.employeeId);
    const matches = await this.employees.ghanaCardLast4Matches(
      caller,
      body.employeeId,
      body.ghanaCardLast4,
    );
    if (matches) {
      await this.throttle.recordSuccess('ghana-card', body.employeeId);
      return;
    }
    await this.throttle.recordFailure('ghana-card', body.employeeId);
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
   */
  private async assertNoOpenQuestion(employeeId: string): Promise<void> {
    const [face, exemption] = await Promise.all([
      this.prisma.biometricCredential.findFirst({
        where: { employeeId, kind: 'FACE', status: { in: ['PENDING', 'BLOCKED'] } },
        select: { status: true },
      }),
      this.prisma.biometricExemption.findFirst({
        where: { employeeId, status: 'REQUESTED' },
        select: { id: true },
      }),
    ]);
    if (face?.status === 'BLOCKED') {
      throw new ConflictException(
        'This record was blocked as a duplicate, so nothing new can be recorded for it.',
      );
    }
    if (face?.status === 'PENDING') {
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

  /** The worker's latest consent row, whichever way it went. */
  private async currentConsent(employeeId: string): Promise<BiometricConsent | null> {
    const latest = await this.prisma.biometricConsent.findFirst({
      where: { employeeId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    return latest?.status === 'GIVEN' ? latest : null;
  }
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
