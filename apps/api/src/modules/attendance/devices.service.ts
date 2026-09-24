import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Device as ApiDevice,
  DeviceList,
  DeviceWithSecret,
  FingerEnrollmentWindow,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Device, Prisma } from '../../generated/prisma/client.js';
import { mayUseAccount } from '../identity/account-rules.js';
import { AuditService } from '../identity/audit.service.js';
import { openSecret, sealSecret } from '../identity/secret-box.js';
import { EmployeesService } from '../workforce/employees.service.js';
import { SitesService } from '../workforce/sites.service.js';
import type {
  ListDevicesQuery,
  OpenFingerEnrollmentWindowBody,
  RegisterDeviceBody,
  UpdateDeviceBody,
} from './attendance.schemas.js';
import { lockCompanyBiometrics } from './attendance-lock.js';
import { blockedRecord } from './biometric-questions.js';
import { deviceSecretKey, newDeviceSecret } from './device-secret.js';

/**
 * How long an ADMIN's fingerprint enrollment window stays open. Long enough
 * to walk a worker to the terminal, short enough that a forgotten window is
 * not a standing invitation. The database refuses a longer one.
 */
export const FINGER_WINDOW_MINUTES = 30;

/** A kiosk session sets up kiosks, never a terminal or a simulator. */
const KIOSK_DEVICES_ONLY = 'A kiosk session can only set up a face kiosk.';

const NO_SUCH_DEVICE = 'No device exists with this ID.';

/**
 * The device registry (ADMIN only). A device's secret is 32 random bytes,
 * shown once and stored only encrypted, with its own key derived from
 * AUTH_SECRET. Contract: the `Devices` operations.
 */
@Injectable()
export class DevicesService {
  private readonly secretKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sites: SitesService,
    private readonly employees: EmployeesService,
    config: AppConfig,
  ) {
    this.secretKey = deviceSecretKey(config.authSecret);
  }

  async list(viewer: SignedInUser, query: ListDevicesQuery): Promise<DeviceList> {
    const afterName = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && afterName === undefined) {
      throw fieldProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    }
    const rows = await this.prisma.device.findMany({
      where: { companyId: viewer.companyId, ...(afterName ? { name: { gt: afterName } } : {}) },
      orderBy: { name: 'asc' },
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.name);
    return { items: pageRows.map(toApiDevice), nextCursor };
  }

  async get(viewer: SignedInUser, deviceId: string): Promise<ApiDevice> {
    return toApiDevice(await this.findInCompany(viewer, deviceId));
  }

  async register(viewer: SignedInUser, body: RegisterDeviceBody): Promise<DeviceWithSecret> {
    // A kiosk sets itself up and nothing else, so a kiosk session can never
    // create a terminal or a simulator (docs/plan/13 section 2).
    if (viewer.onKiosk && body.kind !== 'FACE_KIOSK') {
      throw new ForbiddenException(KIOSK_DEVICES_ONLY);
    }
    // Reuses the sites service's rules; a site outside the company is a clear 400.
    await this.sites.get(viewer, body.siteId).catch((error: unknown) => {
      throw error instanceof NotFoundException
        ? fieldProblem('siteId', 'No site exists with this ID.')
        : error;
    });
    const secret = newDeviceSecret();
    try {
      const device = await this.prisma.$transaction(async (tx) => {
        const created = await tx.device.create({
          data: {
            companyId: viewer.companyId,
            siteId: body.siteId,
            name: body.name,
            kind: body.kind,
            secretEncrypted: sealSecret(secret, this.secretKey),
            // **Every new key is born switched off** (Phase 7): a device key
            // can post punches, so one person never both issues one and puts
            // it to work. Somebody else switches it on, having seen the device
            // is really on the wall (docs/plan/06, "Two administrators"). This
            // was already true of a kiosk setting itself up (docs/plan/13 §3);
            // now it is true of every device.
            status: 'INACTIVE',
            keyIssuedByUserId: viewer.userId,
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'device.registered',
            entityType: 'device',
            entityId: created.id,
            detail: { siteId: body.siteId, kind: body.kind, status: 'INACTIVE' },
          },
          tx,
        );
        return created;
      });
      return { device: toApiDevice(device), secret };
    } catch (error) {
      throw duplicateToConflict(error);
    }
  }

  async update(viewer: SignedInUser, deviceId: string, body: UpdateDeviceBody): Promise<ApiDevice> {
    const current = await this.findInCompany(viewer, deviceId);
    // Rules about the device itself (docs/plan/13 §1); the database checks them too.
    if (body.serialNumber && current.kind !== 'ZKTECO') {
      throw fieldProblem('serialNumber', 'Only a ZKTeco terminal has a serial number.');
    }
    if (body.passkeysEnabled && current.kind !== 'FACE_KIOSK') {
      throw fieldProblem(
        'passkeysEnabled',
        'Only a face kiosk can use its own fingerprint sensor.',
      );
    }
    try {
      const device = await this.prisma.$transaction(async (tx) => {
        // **Locked, then read again.** Whether this is a switch-on depends on
        // the status, and something else may have moved it since — rotating a
        // secret switches a device off. Deciding from the earlier read let a
        // rotate racing a switch-on skip the two-person gate entirely and
        // leave a live key nobody had approved.
        await tx.$queryRaw`SELECT id FROM devices WHERE id = ${deviceId}::uuid AND company_id = ${viewer.companyId}::uuid FOR UPDATE`;
        const locked = await tx.device.findFirst({
          where: { id: deviceId, companyId: viewer.companyId },
        });
        if (!locked) {
          throw new NotFoundException(NO_SUCH_DEVICE);
        }
        const activation =
          body.status === 'ACTIVE' && locked.status !== 'ACTIVE'
            ? await this.whoSwitchesOn(tx, viewer, locked)
            : undefined;
        const updated = await tx.device.update({
          where: { id: deviceId },
          data: {
            ...body,
            ...activation?.columns,
            // Switching a device off clears who switched it on, and when: the
            // next time it goes back on, somebody has to answer for it again.
            ...(body.status === 'INACTIVE' ? { activatedByUserId: null, activatedAt: null } : {}),
          },
        });
        // Switching fingerprints off revokes every key still live on the
        // device, so the change is always visible: its workers clock in
        // face-only until their fingers are saved again.
        const revoked =
          body.passkeysEnabled === false
            ? await tx.devicePasskey.updateMany({
                where: { deviceId, revokedAt: null },
                data: { revokedAt: new Date(), revokedByUserId: viewer.userId },
              })
            : undefined;
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'device.updated',
            entityType: 'device',
            entityId: deviceId,
            detail: {
              changedFields: Object.keys(body).join(','),
              ...(revoked ? { revokedPasskeys: revoked.count } : {}),
              ...activation?.auditDetail,
            },
          },
          tx,
        );
        return updated;
      });
      return toApiDevice(device);
    } catch (error) {
      throw duplicateToConflict(error);
    }
  }

  /** A new secret; the old one stops working at once (no overlap). */
  async rotateSecret(viewer: SignedInUser, deviceId: string): Promise<DeviceWithSecret> {
    const existing = await this.findInCompany(viewer, deviceId);
    if (viewer.onKiosk && existing.kind !== 'FACE_KIOSK') {
      throw new ForbiddenException(KIOSK_DEVICES_ONLY);
    }
    const secret = newDeviceSecret();
    const device = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({
        where: { id: deviceId },
        data: {
          secretEncrypted: sealSecret(secret, this.secretKey),
          // A new key is a new key: it does nothing until somebody else
          // switches the device on again (Phase 7, docs/plan/06). Rotating is
          // how a stolen device is dealt with, so it must not be the way one
          // person quietly gets a working key of their own.
          status: 'INACTIVE',
          keyIssuedByUserId: viewer.userId,
          activatedByUserId: null,
          activatedAt: null,
        },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'device.secret_rotated',
          entityType: 'device',
          entityId: deviceId,
        },
        tx,
      );
      return updated;
    });
    return { device: toApiDevice(device), secret };
  }

  /**
   * Who may switch a device on, and what that writes (Phase 7, docs/plan/06,
   * "Two administrators").
   *
   * **Never the person who issued the key.** A device key can post punches,
   * so the second administrator is the one who checks that the device is
   * really on the wall at that site. Switching a device **off** is open to
   * anybody: it only ever takes power away.
   *
   * The one exception is a company with a single administrator, who has
   * nobody to ask. It is audited as `SOLE_ADMINISTRATOR`, and the
   * database CHECK stays satisfied because nobody else is recorded.
   */
  private async whoSwitchesOn(
    tx: Prisma.TransactionClient,
    viewer: SignedInUser,
    device: Device,
  ): Promise<{
    columns: { activatedByUserId: string | null; activatedAt: Date };
    auditDetail: { activation?: 'SOLE_ADMINISTRATOR' };
  }> {
    const now = new Date();
    if (device.keyIssuedByUserId === null || device.keyIssuedByUserId !== viewer.userId) {
      // Either nobody is recorded (a device older than the rule, or the
      // seed's), or somebody else issued the key. Both are fine.
      return { columns: { activatedByUserId: viewer.userId, activatedAt: now }, auditDetail: {} };
    }
    // **Who could actually do it instead.** An administrator waiting for
    // confirmation of their own account cannot sign in at all, so counting
    // them would refuse this switch-on and name a person who is unable to
    // help — leaving the device stuck until a third administrator appears.
    const others = await tx.user.findMany({
      where: {
        companyId: viewer.companyId,
        role: 'ADMIN',
        isActive: true,
        id: { not: viewer.userId },
      },
      select: {
        isActive: true,
        passwordHash: true,
        role: true,
        twoFactorEnabledAt: true,
        adminRequestedAt: true,
        adminConfirmedAt: true,
      },
    });
    if (others.some((account) => mayUseAccount(account))) {
      throw new ConflictException(
        'You issued this key, so another administrator must switch the device on. They should check it is really the device at that site.',
      );
    }
    return {
      columns: { activatedByUserId: null, activatedAt: now },
      auditDetail: { activation: 'SOLE_ADMINISTRATOR' },
    };
  }

  /** The plain secret of a device, for checking its signatures. Null if it cannot be opened. */
  openDeviceSecret(device: Pick<Device, 'secretEncrypted'>): string | null {
    return openSecret(device.secretEncrypted, this.secretKey);
  }

  /**
   * Opens the 30 minutes in which one worker may enroll a finger on one
   * ZKTeco terminal (docs/plan/13 §5).
   *
   * This is the whole of the rule that stops a terminal enrolling people by
   * itself: no window, no finger. It is refused for a device that is not a
   * terminal, for a worker who is not posted to that terminal's site, and for
   * a worker who never gave consent — a finger is biometric data like any
   * other.
   *
   * Opening a second window for the same worker on the same terminal closes
   * the first, so an ADMIN who taps twice does not leave two open.
   */
  async openFingerEnrollmentWindow(
    viewer: SignedInUser,
    deviceId: string,
    body: OpenFingerEnrollmentWindowBody,
  ): Promise<FingerEnrollmentWindow> {
    const device = await this.findInCompany(viewer, deviceId);
    if (device.kind !== 'ZKTECO') {
      throw new ConflictException('Only a ZKTeco terminal has fingerprint enrollment windows.');
    }
    const worker = await this.employees.atTheKiosk(viewer.companyId, { id: body.employeeId });
    if (!worker) {
      throw new NotFoundException('No employee exists with this ID.');
    }
    const posted = await this.employees.isPostedTo(viewer.companyId, worker.id, device.siteId);
    if (!posted) {
      throw new ConflictException("This worker is not posted to this terminal's site.");
    }
    const consent = await this.prisma.biometricConsent.findFirst({
      where: { companyId: viewer.companyId, employeeId: worker.id },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      select: { status: true },
    });
    if (consent?.status !== 'GIVEN') {
      throw new ConflictException('This worker has not agreed to biometrics.');
    }
    const blocked = await this.prisma.biometricCredential.findFirst({
      where: blockedRecord(viewer.companyId, worker.id),
      select: { id: true },
    });
    if (blocked) {
      // The database refuses this too; saying so here makes it a plain
      // refusal instead of a 500 an ADMIN cannot act on.
      throw new ConflictException(
        'This record was blocked as a duplicate, so it can only be terminated.',
      );
    }

    const opensAt = new Date();
    const expiresAt = new Date(opensAt.getTime() + FINGER_WINDOW_MINUTES * 60 * 1000);
    const window = await this.prisma.$transaction(async (tx) => {
      // This worker's biometric rows, one request at a time, like every other
      // biometric write (docs/plan/13 §2). Without it two ADMINs tapping at
      // once would each close the other's window and then open their own,
      // leaving two open instead of one.
      await lockCompanyBiometrics(tx, viewer.companyId);
      // Close anything still open for this worker on this terminal, so two
      // taps never leave two windows behind.
      await tx.fingerEnrollmentWindow.updateMany({
        where: {
          companyId: viewer.companyId,
          deviceId: device.id,
          employeeId: worker.id,
          expiresAt: { gt: opensAt },
        },
        data: { expiresAt: opensAt },
      });
      const opened = await tx.fingerEnrollmentWindow.create({
        data: {
          companyId: viewer.companyId,
          deviceId: device.id,
          employeeId: worker.id,
          openedByUserId: viewer.userId,
          opensAt,
          expiresAt,
        },
        select: { id: true, deviceId: true, employeeId: true, opensAt: true, expiresAt: true },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'biometric.finger_window_opened',
          entityType: 'employee',
          entityId: worker.id,
          detail: { deviceId: device.id, windowId: opened.id, minutes: FINGER_WINDOW_MINUTES },
        },
        tx,
      );
      return opened;
    });

    return {
      id: window.id,
      deviceId: window.deviceId,
      employeeId: window.employeeId,
      staffNumber: worker.staffNumber,
      opensAt: window.opensAt.toISOString(),
      expiresAt: window.expiresAt.toISOString(),
    };
  }

  private async findInCompany(viewer: SignedInUser, deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, companyId: viewer.companyId },
    });
    if (!device) {
      throw new NotFoundException(NO_SUCH_DEVICE);
    }
    return device;
  }
}

/** Maps a database device to the contract. Never includes the secret. */
export function toApiDevice(device: Device): ApiDevice {
  return {
    id: device.id,
    name: device.name,
    siteId: device.siteId,
    kind: device.kind,
    status: device.status,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    lastClockDriftSeconds: device.lastClockDriftSeconds,
    failedSignatureCount: device.failedSignatureCount,
    lastFailedSignatureAt: device.lastFailedSignatureAt?.toISOString() ?? null,
    serialNumber: device.serialNumber,
    passkeysEnabled: device.passkeysEnabled,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}

function duplicateToConflict(error: unknown): unknown {
  if (isUniqueViolation(error, 'serial_number')) {
    return new ConflictException('Another device already has this serial number.');
  }
  return isUniqueViolation(error, 'name')
    ? new ConflictException('A device with this name already exists.')
    : error;
}
