import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ON_KIOSK_KEY, type SignedInUser } from '../../common/auth.decorators.js';

/** The one answer for a kiosk session that reached for anything else. */
export const KIOSK_SCOPE_REFUSED = 'This kiosk session can only use the kiosk screens.';

/**
 * A kiosk is a shared device standing at a guard post, so an ADMIN signed in
 * on it can only do kiosk work: everything else answers 403, even though the
 * very same account may do it from the dashboard (docs/plan/13 section 2).
 *
 * The rule is the other way round from roles: a route has to say it is a
 * kiosk screen (`@OnKiosk()`), so a new endpoint is never reachable from a
 * kiosk by accident.
 *
 * It runs after the sign-in wall and before the role check.
 */
@Injectable()
export class KioskScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { signedInUser?: SignedInUser }>();
    if (!request.signedInUser?.onKiosk) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean>(ON_KIOSK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) {
      throw new ForbiddenException(KIOSK_SCOPE_REFUSED);
    }
    return true;
  }
}
