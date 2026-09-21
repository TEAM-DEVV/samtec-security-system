import {
  BadRequestException,
  ConflictException,
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
      throw duplicateNameToConflict(error);
    }
  }

  async update(viewer: SignedInUser, deviceId: string, body: UpdateDeviceBody): Promise<ApiDevice> {
    await this.findInCompany(viewer, deviceId);
    try {
      const device = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.device.update({ where: { id: deviceId }, data: body });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'device.updated',
            entityType: 'device',
            entityId: deviceId,
            detail: { changedFields: Object.keys(body).join(',') },
          },
          tx,
        );
        return updated;
      });
      return toApiDevice(device);
    } catch (error) {
      throw duplicateNameToConflict(error);
    }
  }

  /** A new secret; the old one stops working at once (no overlap). */
  async rotateSecret(viewer: SignedInUser, deviceId: string): Promise<DeviceWithSecret> {
    await this.findInCompany(viewer, deviceId);
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
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}

function duplicateNameToConflict(error: unknown): unknown {
  return isUniqueViolation(error, 'name')
    ? new ConflictException('A device with this name already exists.')
    : error;
}
