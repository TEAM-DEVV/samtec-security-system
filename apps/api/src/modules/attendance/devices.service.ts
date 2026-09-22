import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Device as ApiDevice, DeviceList, DeviceWithSecret } from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Device } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { openSecret, sealSecret } from '../identity/secret-box.js';
import { SitesService } from '../workforce/sites.service.js';
import type {
  ListDevicesQuery,
  RegisterDeviceBody,
  UpdateDeviceBody,
} from './attendance.schemas.js';
import { deviceSecretKey, newDeviceSecret } from './device-secret.js';

/** A kiosk session sets up kiosks, never a terminal or a simulator. */
const KIOSK_DEVICES_ONLY = 'A kiosk session can only set up a face kiosk.';

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
            // A kiosk sets itself up, but its key does nothing until an ADMIN
            // switches it on from the dashboard, so a kiosk session alone can
            // never make a working key (docs/plan/13 section 3).
            ...(viewer.onKiosk ? { status: 'INACTIVE' as const } : {}),
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'device.registered',
            entityType: 'device',
            entityId: created.id,
            detail: { siteId: body.siteId, kind: body.kind },
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
        const updated = await tx.device.update({ where: { id: deviceId }, data: body });
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
        data: { secretEncrypted: sealSecret(secret, this.secretKey) },
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

  /** The plain secret of a device, for checking its signatures. Null if it cannot be opened. */
  openDeviceSecret(device: Pick<Device, 'secretEncrypted'>): string | null {
    return openSecret(device.secretEncrypted, this.secretKey);
  }

  private async findInCompany(viewer: SignedInUser, deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, companyId: viewer.companyId },
    });
    if (!device) {
      throw new NotFoundException('No device exists with this ID.');
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
