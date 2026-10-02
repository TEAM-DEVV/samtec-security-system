import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { NEEDS_PASSWORD_KEY, type SignedInUser } from '../../common/auth.decorators.js';
import {
  hasFreshPasswordConfirmation,
  PasswordConfirmationRequiredException,
} from '../../common/password-confirmation.js';

/**
 * Enforces `@NeedsPassword()`: a sensitive route goes ahead only when the
 * caller confirmed their own password in the last five minutes
 * (`POST /auth/confirm-password`, which hands back an access token that
 * carries the confirmation). Otherwise the route answers 403 with
 * `code: PASSWORD_CONFIRMATION_REQUIRED`, and the dashboard asks for the
 * password and sends the request again.
 *
 * This is the safeguard that replaced the two-person rules (issue #99): any
 * administrator may act alone, but a sensitive action needs their password,
 * every action stays in the audit log, and ghost detection still watches the
 * patterns.
 *
 * A kiosk session passes as it is: the administrator typed their password to
 * sign in on the kiosk a few minutes ago, that session lasts fifteen minutes
 * and can reach only the kiosk screens, so the one sensitive thing it can do
 * (register the kiosk itself) needs no second prompt.
 *
 * It runs last, after the sign-in wall, the kiosk limit and the role check.
 */
@Injectable()
export class PasswordConfirmationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const needsPassword = this.reflector.getAllAndOverride<boolean>(NEEDS_PASSWORD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!needsPassword) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & { signedInUser?: SignedInUser }>();
    const user = request.signedInUser;
    if (user?.onKiosk) {
      return true;
    }
    if (!user || !hasFreshPasswordConfirmation(user)) {
      throw new PasswordConfirmationRequiredException();
    }
    return true;
  }
}
