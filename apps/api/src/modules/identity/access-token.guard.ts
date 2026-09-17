import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, type SignedInUser } from '../../common/auth.decorators.js';
import { TokensService } from './tokens.service.js';

/**
 * The sign-in wall. It runs before every route in the API:
 *
 * - A route marked `@Public()` passes straight through.
 * - Every other route needs a valid `Authorization: Bearer <access token>`
 *   header. The caller it names is attached to the request, where the
 *   `@Caller()` decorator picks it up.
 *
 * Registered globally in `identity.module.ts`, so no endpoint can be
 * forgotten: new routes are protected by default.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
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
    const user = token ? await this.tokens.verifyAccessToken(token) : null;
    if (!user) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    request.signedInUser = user;
    return true;
  }
}
