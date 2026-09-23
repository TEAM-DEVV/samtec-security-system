import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '@samtec/contracts';
import type { Request } from 'express';

/** What the access-token guard learns about the caller from their token. */
export interface SignedInUser {
  userId: string;
  companyId: string;
  role: UserRole;
  /** The caller's own employee record, or null for office-only accounts. */
  employeeId: string | null;
  /**
   * True when this session was started on a kiosk at a site. A kiosk is a
   * shared device, so its session may only use the kiosk screens
   * (docs/plan/13 section 2).
   */
  onKiosk: boolean;
}

export const IS_PUBLIC_KEY = 'samtec:isPublic';

/**
 * Marks a route as open to everyone, with no sign-in needed. Every route is
 * protected unless it carries this. Use it only for `/health` and the sign-in
 * endpoints themselves. Device routes use `@DeviceSigned(...)` instead, which
 * adds this together with the device signature check.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const ON_KIOSK_KEY = 'samtec:onKiosk';

/**
 * Marks a route a kiosk session may use. Everything else answers 403 for a
 * kiosk token, so a shared device can never reach the rest of the API, even
 * with an ADMIN signed in on it (docs/plan/13 section 2).
 */
export const OnKiosk = (): MethodDecorator & ClassDecorator => SetMetadata(ON_KIOSK_KEY, true);

export const ROLES_KEY = 'samtec:roles';

/**
 * Limits a route to these roles, for example `@Roles('ADMIN', 'HR_PAYROLL')`.
 * A route without `@Roles` accepts any signed-in user; the service then does
 * its own record-level checks.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Hands a controller method the signed-in caller:
 *
 *   @Get('me')
 *   me(@Caller() caller: SignedInUser) { ... }
 */
export const Caller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SignedInUser => {
    const request = context.switchToHttp().getRequest<Request & { signedInUser?: SignedInUser }>();
    if (!request.signedInUser) {
      // Only reachable if a route forgot the guard, which would be a bug.
      throw new Error('No signed-in user on this request. Is the route marked @Public()?');
    }
    return request.signedInUser;
  },
);
