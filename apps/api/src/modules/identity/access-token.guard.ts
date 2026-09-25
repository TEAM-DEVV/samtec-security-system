import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, type SignedInUser } from '../../common/auth.decorators.js';
import { PrismaService } from '../../database/prisma.service.js';
import { mayUseAccount } from './account-rules.js';
import { TokensService } from './tokens.service.js';

/**
 * The sign-in wall. It runs before every route in the API:
 *
 * - A route marked `@Public()` passes straight through.
 * - Every other route needs a valid `Authorization: Bearer <access token>`
 *   header. The caller it names is attached to the request, where the
 *   `@Caller()` decorator picks it up.
 * - The account behind the token is also checked on every request (one
 *   lookup by ID): it must still be usable, and its role, company and
 *   employee link must still match the token. So switching an account off,
 *   changing its role or resetting its sign-in takes effect on the very next
 *   request — not when the 15-minute token expires.
 *
 * Registered globally in `identity.module.ts`, so no endpoint can be
 * forgotten: new routes are protected by default.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { signedInUser?: SignedInUser }>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    // The signature is checked first, so an invalid token never costs a query.
    const user = token ? await this.tokens.verifyAccessToken(token) : null;
    if (!user || !(await this.stillMatches(user))) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    request.signedInUser = user;
    return true;
  }

  private async stillMatches(user: SignedInUser): Promise<boolean> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        isActive: true,
        passwordHash: true,
        role: true,
        companyId: true,
        employeeId: true,
        twoFactorEnabledAt: true,
        adminRequestedAt: true,
        adminConfirmedAt: true,
      },
    });
    return (
      account !== null &&
      mayUseAccount(account) &&
      account.role === user.role &&
      account.companyId === user.companyId &&
      account.employeeId === user.employeeId
    );
  }
}
