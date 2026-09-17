import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@samtec/contracts';
import type { Request } from 'express';
import { ROLES_KEY, type SignedInUser } from '../../common/auth.decorators.js';

/**
 * Enforces `@Roles(...)`: after the sign-in wall has identified the caller,
 * this guard checks their role against the roles the route allows. A route
 * without `@Roles` accepts any signed-in user, and the service then makes its
 * own record-level decisions (for example, a guard may read only themselves).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & { signedInUser?: SignedInUser }>();
    const role = request.signedInUser?.role;
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenException('Your role does not allow this action.');
    }
    return true;
  }
}
