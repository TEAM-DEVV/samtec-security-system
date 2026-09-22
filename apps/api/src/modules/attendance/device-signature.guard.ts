import type { RawBodyRequest } from '@nestjs/common';
import {
  applyDecorators,
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth.decorators.js';
import { RateLimitException } from '../../common/rate-limit.exception.js';
import { getRequestId } from '../../common/request-id.middleware.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  type DeviceKind,
  kindMayUse,
  type SignedRoute,
  signatureMatches,
  timestampIsFresh,
} from './device-signature.js';
import { DevicesService } from './devices.service.js';

/** The device a signed request came from, as `@CurrentDevice()` hands it over. */
export interface SignedDevice {
  id: string;
  companyId: string;
  siteId: string;
  kind: DeviceKind;
}

/** At most this many signed requests per device per minute. */
export const DEVICE_REQUESTS_PER_MINUTE = 60;

const SIGNED_ROUTE_KEY = 'samtec:signedRoute';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every way a device can fail answers exactly this, so nobody learns which device IDs exist. */
const NOT_TRUSTED = 'The device signature is not valid.';

type DeviceRequest = RawBodyRequest<Request> & { signedDevice?: SignedDevice };

/**
 * Marks a route as called by devices, not users: no access token, but a valid
 * device signature for exactly this route name. The two always go together,
 * so a device route can never end up public by mistake.
 */
export const DeviceSigned = (route: SignedRoute) =>
  applyDecorators(Public(), SetMetadata(SIGNED_ROUTE_KEY, route), UseGuards(DeviceSignatureGuard));

/** Hands a device-signed controller method the device that signed the request. */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SignedDevice => {
    const device = context.switchToHttp().getRequest<DeviceRequest>().signedDevice;
    if (!device) {
      throw new Error('CurrentDevice used on a route without @DeviceSigned');
    }
    return device;
  },
);

/**
 * Checks a device's signature before any of our code reads the body. The
 * order matters: nothing is written to the database until the signature is
 * proven, apart from one rate-limited "someone tried" counter.
 *
 * Contract: the `deviceSignature` security scheme; docs/plan/12 §1.
 */
@Injectable()
export class DeviceSignatureGuard implements CanActivate {
  private readonly logger = new Logger('DeviceSignature');

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<SignedRoute | undefined>(
      SIGNED_ROUTE_KEY,
      context.getHandler(),
    );
    const http = context.switchToHttp();
    const request = http.getRequest<DeviceRequest>();
    const traceId = getRequestId(http.getResponse<Response>());
    const deviceId = request.header('x-samtec-device') ?? '';
    const timestamp = request.header('x-samtec-timestamp') ?? '';
    const signature = request.header('x-samtec-signature') ?? '';

    const refuse = (reason: string): never => {
      // One line with a reason code and IDs only: never the body, the
      // signature or the secret.
      this.logger.warn({ reason, deviceId: UUID.test(deviceId) ? deviceId : null, traceId });
      throw new UnauthorizedException(NOT_TRUSTED);
    };

    if (
      !route ||
      !UUID.test(deviceId) ||
      !/^\d{1,12}$/.test(timestamp) ||
      !/^[0-9a-f]{64}$/.test(signature)
    ) {
      return refuse('bad_headers');
    }
    if (!timestampIsFresh(timestamp, new Date())) {
      return refuse('stale_timestamp');
    }
    if (!request.rawBody) {
      throw new BadRequestException('Signed requests must send a JSON body.');
    }

    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const secret = device?.status === 'ACTIVE' ? this.devices.openDeviceSecret(device) : null;
    if (!device || !secret) {
      return refuse('unknown_or_inactive_device');
    }
    if (!signatureMatches(secret, timestamp, route, request.rawBody, signature)) {
      await this.recordFailedSignature(device.id);
      return refuse('bad_signature');
    }
    await this.countRequest(device.id);
    // Checked after the signature (so only the real device's key reaches it)
    // and after the rate limit (so a leaked kiosk key cannot hammer a route it
    // may not use), with the same answer as every other failure.
    if (!kindMayUse(route, device.kind, this.config.allowSimulatorDevices)) {
      return refuse('kind_not_allowed');
    }
    request.signedDevice = {
      id: device.id,
      companyId: device.companyId,
      siteId: device.siteId,
      kind: device.kind,
    };
    return true;
  }

  /**
   * Counts a wrongly signed request — at most once a minute, so a stranger
   * who knows a device ID can cause at most one database write a minute and
   * can never lock the real device out.
   */
  private async recordFailedSignature(deviceId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE devices
      SET failed_signature_count = failed_signature_count + 1,
          last_failed_signature_at = now()
      WHERE id = ${deviceId}::uuid
        AND (last_failed_signature_at IS NULL OR last_failed_signature_at < now() - interval '1 minute')`;
  }

  /**
   * The per-device rate limit and "last seen", in one atomic statement using
   * the database clock (like the sign-in throttle), so parallel requests can
   * never slip past it. Only correctly signed requests are counted, so a
   * stranger cannot spend a device's budget.
   */
  private async countRequest(deviceId: string): Promise<void> {
    const [window] = await this.prisma.$queryRaw<Array<{ count: number; seconds_left: number }>>`
      UPDATE devices SET
        rate_window_count = CASE
          WHEN rate_window_starts_at IS NULL OR rate_window_starts_at <= now() - interval '1 minute'
          THEN 1 ELSE rate_window_count + 1 END,
        rate_window_starts_at = CASE
          WHEN rate_window_starts_at IS NULL OR rate_window_starts_at <= now() - interval '1 minute'
          THEN now() ELSE rate_window_starts_at END,
        last_seen_at = now()
      WHERE id = ${deviceId}::uuid
      RETURNING rate_window_count AS count,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM rate_window_starts_at + interval '1 minute' - now())))::int AS seconds_left`;
    if (window && window.count > DEVICE_REQUESTS_PER_MINUTE) {
      throw new RateLimitException(
        `Too many requests from this device. Try again in ${window.seconds_left} seconds.`,
        window.seconds_left,
      );
    }
  }
}
