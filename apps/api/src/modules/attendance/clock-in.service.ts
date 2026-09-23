import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type {
  KioskFingerprintOptionsResponse,
  KioskIdentifyResponse,
  KioskPunchResponse,
  KioskWorker,
  PunchResult,
} from '@samtec/contracts';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  AttemptOutcome,
  AttemptPurpose,
  PunchDirection,
} from '../../generated/prisma/enums.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type {
  AssistedPunchBody,
  FingerprintOptionsBody,
  KioskConfirmBody,
  KioskIdentifyBody,
  KioskNotMeBody,
} from './attendance.schemas.js';
import {
  ATTENDANCE_TRANSACTION_OPTIONS,
  AttendanceBusyException,
  isLockTimeout,
  lockCompanyAttendance,
} from './attendance-lock.js';
import { asSealedFaces, BiometricsUnavailableException } from './biometrics.service.js';
import type { SignedDevice } from './device-signature.guard.js';
import { FaceProvider } from './face-provider.js';
import { IngestService } from './ingest.service.js';
import { PasskeysService } from './passkeys.service.js';

/** WebAuthn's own options, as the contract carries them through. */
type FingerprintOptions = NonNullable<KioskIdentifyResponse['fingerprint']>['options'];

/**
 * Either the plain client or one inside a transaction. The eligibility
 * checks read through whichever is in hand, so the co-sign can repeat them
 * inside the punch's own commit, where nothing else can slip past.
 */
type Reader = PrismaService | Prisma.TransactionClient;

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
 * What a usable attempt looks like, per kind. A face attempt is a `MATCHED`
 * one; the staff-number fallback never matches a face at all, so its own
 * outcome is `FINGERPRINT_REQUESTED` (a database CHECK insists on exactly
 * this pairing).
 */
const ATTEMPT_KINDS = {
  CLOCK: { purpose: 'CLOCK', outcome: 'MATCHED' },
  CO_SIGN: { purpose: 'CO_SIGN', outcome: 'MATCHED' },
  STAFF_PASSKEY: { purpose: 'STAFF_PASSKEY', outcome: 'FINGERPRINT_REQUESTED' },
} as const satisfies Record<string, { purpose: AttemptPurpose; outcome: AttemptOutcome }>;

type AttemptKind = keyof typeof ATTEMPT_KINDS;

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
    private readonly employees: EmployeesService,
    private readonly faces: FaceProvider,
    private readonly ingest: IngestService,
    private readonly passkeys: PasskeysService,
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
      throw new BiometricsUnavailableException();
    }

    const found = decision.result;
    const matched = found.outcome === 'MATCHED' ? found : null;
    // A co-sign names the supervisor, not the worker: it is the supervisor
    // who stood in front of the camera.
    const person = matched ? await this.workerOf(device.companyId, matched.employeeId) : null;
    // Once a worker's finger is saved on a kiosk, that kiosk always asks for
    // it: the face says who, the finger confirms. The challenge is written
    // on the attempt, so the answer can only be for this one clock-in.
    const fingerprint = matched
      ? await this.passkeys.challengeFor(device, matched.employeeId)
      : null;
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
        fingerprintChallenge: fingerprint?.challenge ?? null,
        clientAddress: address,
      },
      select: { id: true },
    });
    return {
      attemptId: attempt.id,
      outcome: outcomeOf(found.outcome),
      worker: person,
      fingerprint: fingerprint ? { options: fingerprint as unknown as FingerprintOptions } : null,
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
    const punched = await this.punchOf(device, attempt.id);
    if (punched) {
      // Already a clock-in. Saying "not me" now would turn a recorded shift
      // into a counted failure, three of which open the fallback.
      throw new ConflictException(CANNOT_PUNCH);
    }
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
    const attempt = await this.confirmableAttempt(device, body.attemptId, [
      'CLOCK',
      'STAFF_PASSKEY',
    ]);
    if (attempt.employeeId === null) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    const worker = await this.workerOf(device.companyId, attempt.employeeId);
    if (!worker) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    // A finger that was asked for is required: cancelling it means no punch
    // at all, never a quieter one (docs/plan/13 §4).
    if (attempt.fingerprintChallenge !== null) {
      const answered =
        body.assertion !== undefined &&
        (await this.passkeys.assertionAnswers(
          device,
          attempt.employeeId,
          attempt.fingerprintChallenge,
          body.assertion,
        ));
      if (!answered) {
        throw new ConflictException(CANNOT_PUNCH);
      }
      return this.punch(
        device,
        attempt,
        worker,
        // A staff number opens **any** finger saved on the kiosk, not this
        // worker's own, so its punches are marked apart and the ghost rules
        // count them (docs/plan/13 §4).
        attempt.purpose === 'STAFF_PASSKEY' ? 'STAFF_PASSKEY' : 'FACE_PASSKEY',
      );
    }
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
    const attempt = await this.confirmableAttempt(device, body.coSignAttemptId, ['CO_SIGN']);
    if (attempt.employeeId === null || attempt.staffNumberTried === null) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    const supervisorId = attempt.employeeId;
    const worker = await this.employees.atTheKiosk(device.companyId, {
      staffNumber: attempt.staffNumberTried,
    });
    if (!worker || worker.id === supervisorId) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    if (attempt.fingerprintChallenge !== null) {
      const answered =
        body.assertion !== undefined &&
        (await this.passkeys.assertionAnswers(
          device,
          supervisorId,
          attempt.fingerprintChallenge,
          body.assertion,
        ));
      if (!answered) {
        throw new ConflictException(CANNOT_PUNCH);
      }
    }
    await this.assertMaySupervise(device, supervisorId);
    await this.assertMayBeCoSigned(device, worker.id, worker.status);

    return this.punch(device, attempt, kioskWorker(worker), 'PIN_FALLBACK', async (tx, results) => {
      // Under the company's attendance lock now, so nothing else can be
      // making a punch on this kiosk. The unlock is checked **again**
      // here: two supervisors who both reached the check a moment ago
      // must not both spend the same three failures, and the first
      // punch to commit is what the second one now sees.
      const [result] = results;
      if (result?.status !== 'ACCEPTED') {
        // A resend of a co-sign that already made its punch: nothing new
        // happened, so nothing is checked and nothing is written. The answer
        // is DUPLICATE, which is what a kiosk retrying needs to hear.
        return;
      }
      // Only a punch really being made now is checked again, here inside
      // its own commit, under the company's attendance lock — including the
      // worker's status, read again rather than reused, because a
      // termination may have committed while this request waited.
      const status = await this.employees.statusOf(device.companyId, worker.id, tx);
      await this.assertMayBeCoSigned(device, worker.id, status, tx, attempt);
      await this.audit.record(
        {
          companyId: device.companyId,
          // Nobody is signed in on a kiosk clock-in: the supervisor is
          // the employee the face matched, which the attempt names.
          actorUserId: null,
          action: 'attendance.co_signed',
          entityType: 'punch',
          entityId: result.punchId,
          detail: {
            deviceId: device.id,
            attemptId: attempt.id,
            supervisorEmployeeId: supervisorId,
            employeeId: worker.id,
            direction: attempt.direction,
            reason: body.reason,
          },
        },
        tx,
      );
    });
  }

  /**
   * The staff number and a finger, when the camera will not have this worker
   * (docs/plan/13 §4). The worker types their number and puts a finger on the
   * kiosk's own sensor; the key that answers is their own, saved on this
   * kiosk, so the number alone opens nothing.
   *
   * **Any** finger saved on the kiosk can unlock it, which is why the punch
   * is marked `STAFF_PASSKEY` and counted by the ghost rules — this is the
   * weakest way in, and the report says so.
   *
   * Every call that had an unlock uses it up, whatever the answer, so one run
   * of three failures can never be spent trying staff numbers one after
   * another. The check and the attempt it writes share the company's
   * attendance lock, so two kiosk requests cannot both spend the same unlock.
   */
  async fingerprintOptions(
    device: SignedDevice,
    body: FingerprintOptionsBody,
    address: string | null,
  ): Promise<KioskFingerprintOptionsResponse> {
    const worker = await this.employees.atTheKiosk(device.companyId, {
      staffNumber: body.staffNumber,
    });
    // Everything the answer needs, read before the lock is taken: a locked
    // transaction must never wait on another module (docs/plan/12 §2).
    const allowed =
      worker !== null &&
      worker.status === 'ACTIVE' &&
      (await this.employees.isPostedTo(device.companyId, worker.id, device.siteId));
    const options = allowed ? await this.passkeys.challengeFor(device, worker.id) : null;

    const attempt = await this.spendUnlock(device, {
      companyId: device.companyId,
      deviceId: device.id,
      purpose: 'STAFF_PASSKEY',
      direction: body.direction,
      outcome: options ? 'FINGERPRINT_REQUESTED' : 'FALLBACK_REFUSED',
      // A number that opens nothing is written down as typed and nothing
      // else: the attempt log is how an ADMIN sees a kiosk being probed.
      employeeId: options && worker ? worker.id : null,
      staffNumberTried: body.staffNumber,
      fingerprintChallenge: options?.challenge ?? null,
      clientAddress: address,
    });
    if (!options || !worker) {
      // An unknown number, a worker who is not posted here, one with no
      // finger saved on this kiosk: one answer for all of them.
      throw new ConflictException(CANNOT_PUNCH);
    }
    return {
      attemptId: attempt.id,
      worker: kioskWorker(worker),
      options: options as unknown as KioskFingerprintOptionsResponse['options'],
    };
  }

  /**
   * Writes a fallback attempt under the company's attendance lock, having
   * checked inside that same lock that the fallback really is unlocked.
   *
   * The lock is what makes "every call uses up the unlock" true: without it
   * two requests could both read the same three failures and both go
   * through.
   */
  private async spendUnlock(
    device: SignedDevice,
    data: Prisma.ClockInAttemptUncheckedCreateInput,
  ): Promise<{ id: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCompanyAttendance(tx, device.companyId);
        await this.assertFallbackUnlocked(device, tx);
        return tx.clockInAttempt.create({ data, select: { id: true } });
      }, ATTENDANCE_TRANSACTION_OPTIONS);
    } catch (error) {
      throw isLockTimeout(error) ? new AttendanceBusyException() : error;
    }
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
    kinds: readonly AttemptKind[] = ['CLOCK'],
  ) {
    const attempt = await this.prisma.clockInAttempt.findFirst({
      where: {
        id: attemptId,
        companyId: device.companyId,
        deviceId: device.id,
        OR: kinds.map((kind) => ATTEMPT_KINDS[kind]),
        attemptedAt: { gte: new Date(Date.now() - ATTEMPT_GOOD_FOR_SECONDS * 1000) },
      },
      select: {
        id: true,
        purpose: true,
        direction: true,
        employeeId: true,
        staffNumberTried: true,
        attemptedAt: true,
        fingerprintChallenge: true,
        cancelledBy: { select: { id: true } },
      },
    });
    if (!attempt || attempt.cancelledBy) {
      throw new ConflictException(CANNOT_PUNCH);
    }
    return attempt;
  }

  /** The supervisor must be an ACTIVE SUPERVISOR posted to this kiosk's site. */
  private async assertMaySupervise(
    device: SignedDevice,
    supervisorId: string,
    db: Reader = this.prisma,
  ): Promise<void> {
    const supervisor = await this.employees.atTheKiosk(device.companyId, { id: supervisorId });
    const account = supervisor?.user;
    if (supervisor?.status !== 'ACTIVE' || !account?.isActive || account.role !== 'SUPERVISOR') {
      throw new ConflictException(CANNOT_PUNCH);
    }
    await this.assertPostedHere(device, supervisorId, db);
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
    db: Reader = this.prisma,
    /** The co-sign being made right now, which is not a fallback that already happened. */
    own?: { id: string; attemptedAt: Date },
  ): Promise<void> {
    await this.assertPostedHere(device, employeeId, db);
    const [exemption, face] = await Promise.all([
      db.biometricExemption.findFirst({
        where: {
          companyId: device.companyId,
          employeeId,
          status: { in: ['APPROVED', 'REQUESTED'] },
        },
        select: { status: true, reason: true },
      }),
      db.biometricCredential.findFirst({
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
      await this.assertFallbackUnlocked(device, db, own);
      return;
    }
    throw new ConflictException(CANNOT_PUNCH);
  }

  /**
   * When this kiosk last spent an unlock: **any** staff-number try, or a
   * co-sign that made a punch.
   *
   * The two are not the same on purpose. A staff-number try is counted
   * whatever it answered, because it is one try at a number and three
   * failures must not buy a run of them. A co-sign that was refused used
   * nothing up, because otherwise one refusal would shut the fallback for
   * the next worker in the queue — and a co-sign's punch carries the
   * attempt's own time, with no other kind of `PIN_FALLBACK` punch possible
   * on a kiosk key, so the punch itself says when that one happened.
   */
  private async lastFallbackAt(
    device: SignedDevice,
    db: Reader,
    ownAttemptId?: string,
  ): Promise<Date | null> {
    const [staffNumber, coSigned] = await Promise.all([
      db.clockInAttempt.findFirst({
        where: { deviceId: device.id, purpose: 'STAFF_PASSKEY' },
        orderBy: { attemptedAt: 'desc' },
        select: { attemptedAt: true },
      }),
      db.punchEvent.findFirst({
        // When this runs inside the co-sign's own commit, the punch it is
        // about to make is already there. It is the thing being decided,
        // not a fallback that happened earlier, so it does not count.
        where: {
          deviceId: device.id,
          method: 'PIN_FALLBACK',
          ...(ownAttemptId ? { deviceEventId: { not: ownAttemptId } } : {}),
        },
        // **Server** time, not device time. A co-sign punch carries the
        // supervisor's scan time, which is *earlier* than the failures that
        // unlocked it — using that as the boundary would leave those same
        // failures standing, ready to unlock a second co-sign, and a third.
        orderBy: { serverTime: 'desc' },
        select: { serverTime: true },
      }),
    ]);
    const moments = [staffNumber?.attemptedAt, coSigned?.serverTime].filter(
      (moment): moment is Date => moment !== undefined,
    );
    return moments.length === 0
      ? null
      : new Date(Math.max(...moments.map((moment) => moment.getTime())));
  }

  /** Everyone in a kiosk clock-in must be posted to the site the kiosk stands on. */
  private async assertPostedHere(
    device: SignedDevice,
    employeeId: string,
    db: Reader = this.prisma,
  ): Promise<void> {
    const posted = await this.employees.isPostedTo(device.companyId, employeeId, device.siteId, db);
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
  private async assertFallbackUnlocked(
    device: SignedDevice,
    db: Reader,
    own?: { id: string; attemptedAt: Date },
  ): Promise<void> {
    const since = await this.lastFallbackAt(device, db, own?.id);
    const recent = await db.clockInAttempt.findMany({
      where: {
        deviceId: device.id,
        purpose: 'CLOCK',
        // After the last fallback, and **before** the supervisor scanned:
        // "the kiosk has just failed this worker three times" means failures
        // that already happened when the supervisor stepped in. Without the
        // upper bound, a kiosk could take its co-sign scans first and
        // manufacture the failures afterwards, then spend one run of three
        // on as many absent workers as it liked.
        attemptedAt: {
          ...(since ? { gt: since } : {}),
          ...(own ? { lt: own.attemptedAt } : {}),
        },
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
    method: 'FACE' | 'FACE_PASSKEY' | 'STAFF_PASSKEY' | 'PIN_FALLBACK',
    alsoInTheSameCommit?: (tx: Prisma.TransactionClient, results: PunchResult[]) => Promise<void>,
  ): Promise<KioskPunchResponse> {
    const answer = await this.ingest.ingestPunches(
      device,
      {
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
      },
      async (tx, results) => {
        // Read the cancellation again, here, inside the commit that is
        // making the punch. A worker who taps "Not me" while this request
        // is waiting for the company's lock must still win: otherwise the
        // punch lands under the name they just said was wrong. Throwing
        // rolls the punch back.
        const cancelled = await tx.clockInAttempt.findFirst({
          where: { cancelsAttemptId: attempt.id },
          select: { id: true },
        });
        if (cancelled) {
          throw new ConflictException(CANNOT_PUNCH);
        }
        await alsoInTheSameCommit?.(tx, results);
      },
    );
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

  /** The punch this attempt led to, if it was confirmed on this same device. */
  private async punchOf(device: SignedDevice, attemptId: string): Promise<string | null> {
    const punch = await this.prisma.punchEvent.findFirst({
      where: { companyId: device.companyId, deviceId: device.id, deviceEventId: attemptId },
      select: { id: true },
    });
    return punch?.id ?? null;
  }

  /** The worker this staff number belongs to, if it belongs to anybody here. */
  private async employeeIdOf(companyId: string, staffNumber: string): Promise<string | null> {
    const row = await this.employees.atTheKiosk(companyId, { staffNumber });
    return row?.id ?? null;
  }

  /** How a shared screen names somebody: "Kwame A. (SMT-00042)". */
  private async workerOf(companyId: string, employeeId: string): Promise<KioskWorker | null> {
    const row = await this.employees.atTheKiosk(companyId, { id: employeeId });
    return row ? kioskWorker(row) : null;
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
