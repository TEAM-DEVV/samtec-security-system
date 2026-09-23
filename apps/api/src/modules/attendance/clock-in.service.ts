import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { KioskIdentifyResponse, KioskPunchResponse, KioskWorker } from '@samtec/contracts';
import { PrismaService } from '../../database/prisma.service.js';
import type { AttemptOutcome, PunchDirection } from '../../generated/prisma/enums.js';
import { AuditService } from '../identity/audit.service.js';
import type {
  AssistedPunchBody,
  KioskConfirmBody,
  KioskIdentifyBody,
  KioskNotMeBody,
} from './attendance.schemas.js';
import { asSealedFaces } from './biometrics.service.js';
import type { SignedDevice } from './device-signature.guard.js';
import { FaceProvider } from './face-provider.js';
import { IngestService } from './ingest.service.js';

/** How long a kiosk has to turn an identification into a punch. */
export const ATTEMPT_GOOD_FOR_SECONDS = 60;

/** How recent the newest failure must be for the fallbacks to unlock. */
export const UNLOCK_WINDOW_SECONDS = 120;

/** How many face attempts in a row must fail before a fallback is offered. */
export const FAILURES_BEFORE_FALLBACK = 3;

/**
 * One answer for every refusal on the kiosk, whatever the real reason.
 *
 * A kiosk stands at a gate where anyone can walk up to it. If it said "that
 * worker is not posted here" or "that worker has no exemption", it could be
 * used to learn who works where, and who is enrolled — so every refusal
 * says the same thing (docs/plan/13 section 3).
 */
export const CANNOT_PUNCH = 'This cannot be recorded here. Ask your supervisor.';

/**
 * The clock-in itself (docs/plan/13-biometrics-design.md section 3).
 *
 * Three steps, so nothing is ever recorded on a guess: **identify** says who
 * is at the camera and writes down the attempt, the kiosk shows the name for
 * two seconds, and **confirm** turns that attempt into a punch. "Not me"
 * cancels one the kiosk got wrong. A supervisor's **co-sign** is the way in
 * for the three kinds of worker who cannot use their own face.
 *
 * The punch itself is always made by Phase 2's own pipeline, so a kiosk
 * punch is paired, checked and queued exactly like a terminal's. The kiosk
 * never chooses the time or the method: the server does, from the attempt it
 * wrote itself, which is why a kiosk cannot backdate a shift.
 */
@Injectable()
export class ClockInService {
  private readonly logger = new Logger('ClockIn');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly faces: FaceProvider,
    private readonly ingest: IngestService,
  ) {}

  /**
   * Who is at the camera? Compares the face with every face in use in the
   * company, records the attempt whatever the answer, and makes no punch.
   *
   * The answer never carries a score. Being told "you were close" would let
   * somebody hold up photographs until the number went up, which is exactly
   * how a stored face gets stolen.
   */
  async identify(
    device: SignedDevice,
    body: KioskIdentifyBody,
    address: string | null,
  ): Promise<KioskIdentifyResponse> {
    const faces = await this.prisma.biometricCredential.findMany({
      where: {
        companyId: device.companyId,
        kind: 'FACE',
        status: 'ACTIVE',
        wipedAt: null,
        dedupe: { in: ['PASSED', 'CLEARED'] },
      },
      select: {
        id: true,
        companyId: true,
        employeeId: true,
        keyVersion: true,
        templateSealed: true,
      },
    });
    const decision = this.faces.identify(body.sample, asSealedFaces(faces));
    if (decision.unreadable.length > 0) {
      // A face nobody could open is a face nobody compared against, so the
      // lead rule no longer means anything. Refuse rather than guess, and
      // tell the ADMIN which rows by id — never by their numbers.
      this.logger.error({
        reason: 'unreadable_faces',
        credentialIds: decision.unreadable,
        companyId: device.companyId,
        deviceId: device.id,
      });
      throw new FaceMatchingUnavailableException();
    }

    const found = decision.result;
    const matched = found.outcome === 'MATCHED' ? found : null;
    // A co-sign names the supervisor, not the worker: it is the supervisor
    // who stood in front of the camera.
    const person = matched ? await this.workerOf(device.companyId, matched.employeeId) : null;
    const attempt = await this.prisma.clockInAttempt.create({
      data: {
        companyId: device.companyId,
        deviceId: device.id,
        purpose: body.purpose,
        direction: body.direction,
        outcome: outcomeOf(found.outcome),
        employeeId: matched?.employeeId ?? null,
        // Written down, never checked: nothing about this worker is looked
        // at until `kiosk/assisted-punches`, and nothing about them reaches
        // the answer, so a kiosk cannot be used to learn who works where.
        // The id is filled in when the number is one of ours, which is all
        // the attempt log needs to show a name later.
        staffNumberTried: body.purpose === 'CO_SIGN' ? body.staffNumber : null,
        coSignForEmployeeId:
          body.purpose === 'CO_SIGN'
            ? await this.employeeIdOf(device.companyId, body.staffNumber)
            : null,
        bestScore: found.scores.best,
        runnerUpScore: found.scores.runnerUp,
        realScore: body.sample.real,
        liveScore: body.sample.live,
        thresholdVersion: this.faces.thresholdVersion,
        clientAddress: address,
      },
      select: { id: true },
    });
    return {
      attemptId: attempt.id,
      outcome: outcomeOf(found.outcome),
      worker: person,
      // Fingerprints arrive with the passkeys in pull request 7.
      fingerprint: null,
    };
  }

  /**
   * The kiosk named the wrong person. The matched attempt can never become a
   * punch now, and this counts as one failed try towards the fallbacks.
   *
   * Attempts are append-only, so this is a new row pointing at the one it
   * cancels; the database's own unique rule means a second "Not me" for the
   * same attempt cannot be stored.
   */
  async notMe(device: SignedDevice, body: KioskNotMeBody, address: string | null): Promise<void> {
    const attempt = await this.confirmableAttempt(device, body.attemptId);
    if (attempt.employeeId === null) {
      // A match always names somebody (a database CHECK), so this is only
      // reachable if that stopped being true.
      throw new ConflictException(CANNOT_PUNCH);
    }
    await this.prisma.clockInAttempt.create({
      data: {
        companyId: device.companyId,
        deviceId: device.id,
        purpose: 'CLOCK',
        direction: attempt.direction,
        outcome: 'NOT_ME',
        // Who the kiosk wrongly said it was. The pilot counts these to see
        // whether the thresholds are set right.
        employeeId: attempt.employeeId,
        cancelsAttemptId: attempt.id,
        clientAddress: address,
      },
      select: { id: true },
    });
  }

  /**
   * Turn an identification into a punch. The attempt must be this device's
   * own, a match, a clock-in (never a co-sign), less than a minute old and
   * not cancelled — and the punch is made from the attempt, not from
   * anything the kiosk sends now.
   */
  async confirm(device: SignedDevice, body: KioskConfirmBody): Promise<KioskPunchResponse> {
    const attempt = await this.confirmableAttempt(device, body.attemptId);
    if (attempt.employeeId === null) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    const worker = await this.workerOf(device.companyId, attempt.employeeId);
    if (!worker) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    // Pull request 7 adds FACE_PASSKEY here, when the kiosk's own sensor
    // confirmed the face.
    return this.punch(device, attempt, worker, 'FACE');
  }

  /**
   * A site supervisor confirms one named worker who cannot use their own
   * face. It makes exactly one `PIN_FALLBACK` punch — flagged, and counted
   * as such by payroll — and the reason is kept with the audit record.
   *
   * Only three kinds of worker qualify, and the **server** decides which,
   * because the kiosk must not be able to find out (docs/plan/13 §3).
   */
  async assistedPunch(device: SignedDevice, body: AssistedPunchBody): Promise<KioskPunchResponse> {
    const attempt = await this.confirmableAttempt(device, body.coSignAttemptId, 'CO_SIGN');
    if (attempt.employeeId === null || attempt.staffNumberTried === null) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    const supervisorId = attempt.employeeId;
    const worker = await this.prisma.employee.findFirst({
      where: { companyId: device.companyId, staffNumber: attempt.staffNumberTried },
      select: { id: true, staffNumber: true, firstName: true, lastName: true, status: true },
    });
    if (!worker || worker.id === supervisorId) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    await this.assertMaySupervise(device, supervisorId);
    await this.assertMayBeCoSigned(device, worker.id, worker.status);

    const punch = await this.punch(device, attempt, kioskWorker(worker), 'PIN_FALLBACK');
    await this.audit.record({
      companyId: device.companyId,
      // Nobody is signed in on a kiosk clock-in: the supervisor is the
      // employee the face matched, which the attempt already names.
      actorUserId: null,
      action: 'attendance.co_signed',
      entityType: 'punch',
      entityId: punch.punchId,
      detail: {
        deviceId: device.id,
        attemptId: attempt.id,
        supervisorEmployeeId: supervisorId,
        employeeId: worker.id,
        direction: attempt.direction,
        reason: body.reason,
      },
    });
    return punch;
  }

  /**
   * The attempt this call is about, if it may still be used: this device's
   * own, a match, the right purpose, under a minute old, not cancelled and
   * not already a punch.
   *
   * "Already a punch" is not a column — attempts never change once written.
   * It is the punch itself, found by the attempt's id, which is also what
   * makes a resend answer `DUPLICATE` instead of making a second punch.
   */
  private async confirmableAttempt(
    device: SignedDevice,
    attemptId: string,
    purpose: 'CLOCK' | 'CO_SIGN' = 'CLOCK',
  ) {
    const attempt = await this.prisma.clockInAttempt.findFirst({
      where: {
        id: attemptId,
        companyId: device.companyId,
        deviceId: device.id,
        purpose,
        outcome: 'MATCHED',
        attemptedAt: { gte: new Date(Date.now() - ATTEMPT_GOOD_FOR_SECONDS * 1000) },
      },
      select: {
        id: true,
        direction: true,
        employeeId: true,
        staffNumberTried: true,
        attemptedAt: true,
        cancelledBy: { select: { id: true } },
      },
    });
    if (!attempt || attempt.cancelledBy) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    return attempt;
  }

  /** The supervisor must be an ACTIVE SUPERVISOR posted to this kiosk's site. */
  private async assertMaySupervise(device: SignedDevice, supervisorId: string): Promise<void> {
    const supervisor = await this.prisma.employee.findFirst({
      where: { id: supervisorId, companyId: device.companyId, status: 'ACTIVE' },
      select: { user: { select: { role: true, isActive: true } } },
    });
    const account = supervisor?.user;
    if (!account || !account.isActive || account.role !== 'SUPERVISOR') {
      throw new ConflictException(CANNOT_PUNCH);
    }
    await this.assertPostedHere(device, supervisorId);
  }

  /**
   * The three kinds of worker a supervisor may co-sign for, and nobody else
   * (docs/plan/13 §3):
   *
   * 1. one an exemption two ADMINs approved says works without biometrics;
   * 2. one whose withdrawal of consent is still waiting for a second ADMIN —
   *    their punches are recorded and queried, and paid once it is approved;
   * 3. one who is at work with a face in use, but whose face the kiosk has
   *    failed to read three times in a row just now.
   *
   * The first two need no face attempt at all — asking somebody who refused
   * biometrics to stand in front of a camera would make the refusal
   * meaningless. Only the third uses up the unlock.
   */
  private async assertMayBeCoSigned(
    device: SignedDevice,
    employeeId: string,
    status: string,
  ): Promise<void> {
    await this.assertPostedHere(device, employeeId);
    const [exemption, face] = await Promise.all([
      this.prisma.biometricExemption.findFirst({
        where: {
          companyId: device.companyId,
          employeeId,
          status: { in: ['APPROVED', 'REQUESTED'] },
        },
        select: { status: true, reason: true },
      }),
      this.prisma.biometricCredential.findFirst({
        where: {
          companyId: device.companyId,
          employeeId,
          kind: 'FACE',
          status: 'ACTIVE',
          wipedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (status === 'ACTIVE' && exemption?.status === 'APPROVED') {
      return;
    }
    if (
      status === 'PENDING_ENROLLMENT' &&
      exemption?.status === 'REQUESTED' &&
      exemption.reason === 'CONSENT_WITHDRAWN'
    ) {
      // The punch is stored and raises INACTIVE_EMPLOYEE, exactly as Phase 2
      // does for anybody waiting, and payroll counts it once approved.
      return;
    }
    if (status === 'ACTIVE' && face) {
      await this.assertFallbackUnlocked(device);
      return;
    }
    throw new ConflictException(CANNOT_PUNCH);
  }

  /**
   * When this kiosk last let somebody past the face: a staff number with a
   * finger, or a co-sign that made a punch.
   *
   * A co-sign's punch carries the attempt's own time, and a kiosk can make
   * no other kind of `PIN_FALLBACK` punch — raw punches are refused on a
   * kiosk key — so the punch itself says when that fallback happened.
   */
  private async lastFallbackAt(device: SignedDevice): Promise<Date | null> {
    const [staffNumber, coSigned] = await Promise.all([
      this.prisma.clockInAttempt.findFirst({
        where: { deviceId: device.id, purpose: 'STAFF_PASSKEY' },
        orderBy: { attemptedAt: 'desc' },
        select: { attemptedAt: true },
      }),
      this.prisma.punchEvent.findFirst({
        where: { deviceId: device.id, method: 'PIN_FALLBACK' },
        orderBy: { deviceTime: 'desc' },
        select: { deviceTime: true },
      }),
    ]);
    const moments = [staffNumber?.attemptedAt, coSigned?.deviceTime].filter(
      (moment): moment is Date => moment !== undefined,
    );
    return moments.length === 0
      ? null
      : new Date(Math.max(...moments.map((moment) => moment.getTime())));
  }

  /** Everyone in a kiosk clock-in must be posted to the site the kiosk stands on. */
  private async assertPostedHere(device: SignedDevice, employeeId: string): Promise<void> {
    const today = new Date();
    const posted = await this.prisma.siteAssignment.findFirst({
      where: {
        companyId: device.companyId,
        employeeId,
        siteId: device.siteId,
        startsOn: { lte: today },
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      select: { id: true },
    });
    if (!posted) {
      throw new ConflictException(CANNOT_PUNCH);
    }
  }

  /**
   * The fallback unlocks only when this kiosk has just failed a worker three
   * times in a row: the 3 newest clock attempts on this device since its
   * last fallback all failed, and the newest is under two minutes old.
   *
   * A match the worker cancelled with "Not me" is one failure, not two, so
   * the cancelled match is skipped and its `NOT_ME` row counted instead.
   *
   * "Since its last fallback" means a fallback that **worked**: a staff
   * number and finger, or a co-sign that really made a punch. A co-sign that
   * was refused used nothing up, so it does not reset the count — otherwise
   * one refusal would shut the fallback for the next worker in the queue.
   */
  private async assertFallbackUnlocked(device: SignedDevice): Promise<void> {
    const since = await this.lastFallbackAt(device);
    const recent = await this.prisma.clockInAttempt.findMany({
      where: {
        deviceId: device.id,
        purpose: 'CLOCK',
        ...(since ? { attemptedAt: { gt: since } } : {}),
      },
      orderBy: { attemptedAt: 'desc' },
      // One more than needed, so a match cancelled by "Not me" can be
      // dropped without the count silently falling short.
      take: FAILURES_BEFORE_FALLBACK * 2,
      select: { id: true, outcome: true, attemptedAt: true, cancelledBy: { select: { id: true } } },
    });
    const tries = recent
      .filter((attempt) => !attempt.cancelledBy)
      .slice(0, FAILURES_BEFORE_FALLBACK);
    const newest = tries[0];
    const allFailed =
      tries.length === FAILURES_BEFORE_FALLBACK &&
      tries.every((attempt) => attempt.outcome !== 'MATCHED');
    const freshEnough =
      newest !== undefined &&
      Date.now() - newest.attemptedAt.getTime() <= UNLOCK_WINDOW_SECONDS * 1000;
    if (!allFailed || !freshEnough) {
      throw new ConflictException(CANNOT_PUNCH);
    }
  }

  /**
   * Makes the punch through Phase 2's own pipeline, so a kiosk punch is
   * stored, matched, paired and queued exactly like a terminal's.
   *
   * The attempt's id becomes the punch's `deviceEventId`. That one choice
   * gives three rules at once: a resend answers `DUPLICATE`, a co-sign can
   * never be spent twice, and every punch can be traced back to the attempt
   * that made it without ever changing the attempt.
   */
  private async punch(
    device: SignedDevice,
    attempt: { id: string; direction: PunchDirection; attemptedAt: Date },
    worker: KioskWorker,
    method: 'FACE' | 'PIN_FALLBACK',
  ): Promise<KioskPunchResponse> {
    const answer = await this.ingest.ingestPunches(device, {
      punches: [
        {
          deviceEventId: attempt.id,
          deviceUserRef: worker.staffNumber,
          // The server's own time of the attempt: a kiosk cannot backdate.
          deviceTime: attempt.attemptedAt.toISOString(),
          direction: attempt.direction === 'OUT' ? 'OUT' : 'IN',
          method,
        },
      ],
    });
    const [result] = answer.results;
    if (!result) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    if (result.status === 'CONFLICT') {
      // The same attempt id with different content: only reachable if this
      // service contradicted itself, which would be a bug worth seeing.
      throw new ConflictException(CANNOT_PUNCH);
    }
    return {
      punchId: result.punchId,
      status: result.status === 'DUPLICATE' ? 'DUPLICATE' : 'ACCEPTED',
      method,
      direction: attempt.direction === 'OUT' ? 'OUT' : 'IN',
      recordedAt: attempt.attemptedAt.toISOString(),
      worker,
    };
  }

  /** The worker this staff number belongs to, if it belongs to anybody here. */
  private async employeeIdOf(companyId: string, staffNumber: string): Promise<string | null> {
    const row = await this.prisma.employee.findFirst({
      where: { companyId, staffNumber },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** How a shared screen names somebody: "Kwame A. (SMT-00042)". */
  private async workerOf(companyId: string, employeeId: string): Promise<KioskWorker | null> {
    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { staffNumber: true, firstName: true, lastName: true },
    });
    return row ? kioskWorker(row) : null;
  }
}

/** The kiosk's answer when a stored face cannot be opened: try again later. */
export class FaceMatchingUnavailableException extends ConflictException {
  constructor() {
    super('Face matching is not available on this kiosk right now. Tell your supervisor.');
  }
}

/**
 * A first name and the initial of the surname, never the whole name: a
 * kiosk screen stands where anyone can read it.
 */
function kioskWorker(row: {
  staffNumber: string;
  firstName: string;
  lastName: string;
}): KioskWorker {
  const initial = row.lastName.trim().charAt(0).toUpperCase();
  return {
    displayName: initial ? `${row.firstName} ${initial}.` : row.firstName,
    staffNumber: row.staffNumber,
  };
}

/**
 * The matcher's own words, as the attempt log records them. `REFUSED` only
 * ever reaches here as a face that did not look real or alive: the other two
 * problems (another model, the wrong number of numbers) are refused by the
 * request schema long before a face is opened.
 */
function outcomeOf(
  outcome: 'MATCHED' | 'AMBIGUOUS' | 'NOT_RECOGNISED' | 'REFUSED',
): AttemptOutcome {
  return outcome === 'REFUSED' ? 'LOW_LIVENESS' : outcome;
}
