import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import type { DevicePasskey, PasskeyOptionsResponse } from '@samtec/contracts';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import type { PasskeyOptionsBody, RegisterPasskeyBody } from './attendance.schemas.js';
import type { SignedDevice } from './device-signature.guard.js';
import { openTicket, passkeyTicketKey, sealTicket } from './passkey-ticket.js';

/** WebAuthn's own options object, as the browser expects it. */
type AuthenticationOptions = Awaited<ReturnType<typeof generateAuthenticationOptions>>;

/**
 * The finger, on the kiosk's own sensor (docs/plan/13 section 4).
 *
 * What SAMTEC keeps is **not a fingerprint**. It is the public half of a key
 * the device made and will only unlock when a finger enrolled in the
 * device's own settings is presented. The finger never leaves the device,
 * and the device never tells us whose finger it was — which is exactly why
 * the face is what identifies a worker and the finger only confirms it.
 *
 * Nothing is written down until a key really exists: a registration's
 * challenge travels to the kiosk and back inside a sealed ticket
 * (`passkey-ticket.ts`), so there are no half-finished registrations to
 * expire or clean up. A clock-in's challenge rides on the attempt row, which
 * both halves of a clock-in already share.
 */
@Injectable()
export class PasskeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Ask the device to make a key for this worker. An ADMIN does this on the
   * kiosk, after the worker's face is enrolled and their finger is already
   * saved in the device's settings.
   */
  async options(
    caller: SignedInUser,
    device: SignedDevice,
    body: PasskeyOptionsBody,
  ): Promise<PasskeyOptionsResponse> {
    const worker = await this.workerWithFace(caller.companyId, device, body.employeeId);
    const existing = await this.prisma.devicePasskey.findMany({
      where: { companyId: caller.companyId, employeeId: worker.id, revokedAt: null },
      select: { credentialId: true },
    });
    const options = await generateRegistrationOptions({
      rpName: 'SAMTEC',
      rpID: this.relyingParty(),
      // The staff number and a random id, never a name and never anything
      // that could identify the worker: a synced key can end up in the
      // kiosk's own cloud account (docs/plan/13 §4).
      userID: randomBytes(32),
      userName: worker.staffNumber,
      userDisplayName: worker.staffNumber,
      attestationType: 'none',
      excludeCredentials: existing.map((key) => ({ id: key.credentialId })),
      authenticatorSelection: {
        // The device's own sensor, not a phone or a security key held
        // nearby, and the finger itself is required.
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
    });
    return {
      ticket: sealTicket(
        {
          purpose: 'REGISTER',
          companyId: caller.companyId,
          employeeId: worker.id,
          deviceId: device.id,
          challenge: options.challenge,
        },
        this.ticketKey(),
      ),
      // The contract carries WebAuthn's own options through untouched.
      options: options as unknown as PasskeyOptionsResponse['options'],
    };
  }

  /**
   * Save the key the device made. It replaces any earlier key this worker
   * had on this device, so a re-registration is never a second live key.
   */
  async register(
    caller: SignedInUser,
    device: SignedDevice,
    body: RegisterPasskeyBody,
  ): Promise<DevicePasskey> {
    const worker = await this.workerWithFace(caller.companyId, device, body.employeeId);
    const ticket = openTicket(body.ticket, this.ticketKey(), {
      purpose: 'REGISTER',
      companyId: caller.companyId,
      deviceId: device.id,
      employeeId: worker.id,
    });
    if (!ticket) {
      throw new ConflictException(PASSKEY_REFUSED);
    }

    const checked = await this.verifyRegistration(body.response, ticket.challenge);
    if (!checked?.verified || !checked.registrationInfo) {
      throw new ConflictException(PASSKEY_REFUSED);
    }
    const { credential, credentialDeviceType, userVerified } = checked.registrationInfo;
    if (!userVerified) {
      // No finger, no key: a device PIN alone is not what was asked for.
      throw new ConflictException(PASSKEY_REFUSED);
    }

    return this.prisma.$transaction(async (tx) => {
      // This worker's row first, as every biometric write does (docs/plan/13
      // §2). Without it two registrations could both revoke, both insert,
      // and the "one live key per kiosk" rule would fail one of them with a
      // database error instead of a plain refusal.
      await lockWorker(tx, worker.id);
      await tx.devicePasskey.updateMany({
        where: {
          companyId: caller.companyId,
          employeeId: worker.id,
          deviceId: device.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedByUserId: caller.userId },
      });
      const saved = await tx.devicePasskey.create({
        data: {
          companyId: caller.companyId,
          employeeId: worker.id,
          deviceId: device.id,
          credentialId: credential.id,
          publicKey: credential.publicKey,
          signCount: BigInt(credential.counter),
          // The device says it may copy this key to its cloud account. The
          // report has to mention it: a synced key is a key that can exist
          // on hardware nobody here has ever seen.
          backedUp: credentialDeviceType === 'multiDevice',
          registeredByUserId: caller.userId,
        },
        select: {
          id: true,
          registeredAt: true,
          revokedAt: true,
          backedUp: true,
          device: { select: { id: true, name: true } },
        },
      });
      await this.audit.record(
        {
          companyId: caller.companyId,
          actorUserId: caller.userId,
          action: 'biometric.passkey_registered',
          entityType: 'employee',
          entityId: worker.id,
          detail: { deviceId: device.id, synced: credentialDeviceType === 'multiDevice' },
        },
        tx,
      );
      return {
        id: saved.id,
        deviceId: saved.device.id,
        deviceName: saved.device.name,
        registeredAt: saved.registeredAt.toISOString(),
        synced: saved.backedUp,
        revokedAt: saved.revokedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * The challenge a worker's own key must answer, when they have one on this
   * device. `null` when they have none, which is how a kiosk with no sensor
   * — or a worker whose finger was never saved — simply carries on by face.
   *
   * The challenge is written on the attempt itself, because that is the one
   * row both halves of a clock-in already share: identify writes it, confirm
   * reads it back, and an attempt is append-only, so it can never be swapped
   * for a challenge the kiosk liked better.
   */
  async challengeFor(
    device: SignedDevice,
    employeeId: string,
  ): Promise<AuthenticationOptions | null> {
    const keys = await this.liveKeys(device, employeeId);
    if (keys.length === 0) {
      return null;
    }
    return generateAuthenticationOptions({
      rpID: this.relyingParty(),
      allowCredentials: keys.map((key) => ({ id: key.credentialId })),
      userVerification: 'required',
    });
  }

  /**
   * Did this worker's own finger, on this device, answer this challenge?
   *
   * Checks the signature against the public half we kept, that the key is
   * one of **this worker's** on **this device**, that the finger itself was
   * verified (not just a screen unlock), and that the key's counter has not
   * gone backwards — which is what a cloned key looks like.
   */
  async assertionAnswers(
    device: SignedDevice,
    employeeId: string,
    challenge: string,
    assertion: unknown,
  ): Promise<boolean> {
    const given = assertion as { id?: unknown };
    const keys = await this.liveKeys(device, employeeId);
    const key = keys.find((row) => row.credentialId === given?.id);
    if (!key) {
      return false;
    }
    let checked: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      checked = await verifyAuthenticationResponse({
        response: assertion as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: [...this.config.kioskOrigins],
        expectedRPID: this.relyingParty(),
        requireUserVerification: true,
        credential: {
          id: key.credentialId,
          publicKey: key.publicKey,
          counter: Number(key.signCount),
        },
      });
    } catch {
      // Every way an assertion can be wrong gets the same answer.
      return false;
    }
    if (!checked.verified) {
      return false;
    }
    const { newCounter } = checked.authenticationInfo;
    if (newCounter > Number(key.signCount)) {
      // The counter only ever goes up; the database refuses anything else.
      await this.prisma.devicePasskey.updateMany({
        where: { companyId: device.companyId, employeeId, credentialId: key.credentialId },
        data: { signCount: BigInt(newCounter), lastUsedAt: new Date() },
      });
    } else {
      await this.prisma.devicePasskey.updateMany({
        where: { companyId: device.companyId, employeeId, credentialId: key.credentialId },
        data: { lastUsedAt: new Date() },
      });
    }
    return true;
  }

  /** The worker must be in this company, on this kiosk's site, with a face in use. */
  private async workerWithFace(companyId: string, device: SignedDevice, employeeId: string) {
    const kiosk = await this.prisma.device.findFirst({
      where: { id: device.id, companyId, kind: 'FACE_KIOSK', passkeysEnabled: true },
      select: { id: true },
    });
    if (!kiosk) {
      throw new ConflictException(PASSKEY_REFUSED);
    }
    const worker = await this.prisma.employee.findFirst({
      where: {
        id: employeeId,
        companyId,
        biometricCredentials: { some: { kind: 'FACE', status: 'ACTIVE', wipedAt: null } },
      },
      select: { id: true, staffNumber: true },
    });
    if (!worker) {
      throw new ConflictException(PASSKEY_REFUSED);
    }
    return worker;
  }

  private async liveKeys(device: SignedDevice, employeeId: string) {
    return this.prisma.devicePasskey.findMany({
      where: {
        companyId: device.companyId,
        employeeId,
        deviceId: device.id,
        revokedAt: null,
      },
      select: { credentialId: true, publicKey: true, signCount: true },
    });
  }

  private async verifyRegistration(response: unknown, challenge: string) {
    try {
      return await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: [...this.config.kioskOrigins],
        expectedRPID: this.relyingParty(),
        requireUserVerification: true,
      });
    } catch {
      // Every way a registration can be wrong gets the same answer.
      return null;
    }
  }

  /** Anything WebAuthn refuses, for any reason, gets this one answer. */
  private ticketKey(): Buffer {
    return passkeyTicketKey(this.config.authSecret);
  }

  /**
   * The domain the key belongs to: the kiosk's own. A key made for one
   * domain can never be used on another, which is what stops a copied
   * kiosk page from asking for somebody's finger.
   */
  private relyingParty(): string {
    const [first] = this.config.kioskOrigins;
    if (!first) {
      throw new ConflictException(PASSKEY_REFUSED);
    }
    return new URL(first).hostname;
  }
}

/**
 * Takes this worker's row for the rest of the transaction, so the rows about
 * one person are written one at a time (the same rule, and the same ten
 * second cap, as every other biometric write).
 */
async function lockWorker(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
  await tx.$queryRaw`SELECT 1 FROM employees WHERE id = ${employeeId}::uuid FOR NO KEY UPDATE`;
}

/** One answer for every way a fingerprint step can be refused. */
export const PASSKEY_REFUSED = 'This fingerprint step cannot be completed here.';
