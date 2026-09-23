import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { OnKiosk, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  DeviceSignatureGuard,
  SIGNED_ROUTE_KEY,
  type SignedDevice,
} from './device-signature.guard.js';
import type { SignedRoute } from './device-signature.js';

/** The one answer when the ADMIN and the kiosk do not belong together. */
const NOT_TRUSTED = 'The device signature is not valid.';

/**
 * A kiosk ADMIN route: it needs **both** an ADMIN who signed in on a kiosk
 * **and** that kiosk's signature (docs/plan/13 section 2). A stolen ADMIN
 * password alone cannot enroll anyone, and neither can a stolen kiosk without
 * an ADMIN.
 *
 * Unlike `@DeviceSigned`, this does not make the route public: the sign-in
 * wall still runs, so the token is checked first, then the signature.
 */
export const KioskOperator = (route: SignedRoute) =>
  applyDecorators(
    OnKiosk(),
    Roles('ADMIN'),
    SetMetadata(SIGNED_ROUTE_KEY, route),
    UseGuards(DeviceSignatureGuard, KioskOperatorGuard),
  );

/**
 * Runs after the signature guard: the session must be a kiosk one (a
 * dashboard token is refused), and the kiosk must belong to the ADMIN's own
 * company. Every failure answers the same as a wrong signature, so nobody
 * learns which device IDs exist.
 */
@Injectable()
export class KioskOperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { signedInUser?: SignedInUser; signedDevice?: SignedDevice }>();
    const user = request.signedInUser;
    const device = request.signedDevice;
    if (!user?.onKiosk || !device || device.companyId !== user.companyId) {
      throw new UnauthorizedException(NOT_TRUSTED);
    }
    return true;
  }
}
