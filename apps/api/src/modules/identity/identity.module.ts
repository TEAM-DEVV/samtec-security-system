import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccountsService } from './accounts.service.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { KioskScopeGuard } from './kiosk-scope.guard.js';
import { RolesGuard } from './roles.guard.js';
import { SignInThrottleService } from './sign-in-throttle.service.js';
import { TokensService } from './tokens.service.js';

/**
 * The identity module: who can sign in, what their role allows, and the audit
 * log of what everyone did (docs/plan/03-system-architecture.md).
 *
 * The three `APP_GUARD` lines protect the whole API, in order: the sign-in
 * wall (`AccessTokenGuard`), then the kiosk limit (`KioskScopeGuard`), then
 * the role check (`RolesGuard`). Because they are global, every new endpoint
 * anywhere in the API requires sign-in unless it is explicitly marked
 * `@Public()`, and is out of a kiosk session's reach unless it is marked
 * `@OnKiosk()`.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AccountsService,
    TokensService,
    SignInThrottleService,
    AuditService,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: KioskScopeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccountsService, AuditService, SignInThrottleService, TokensService],
})
export class IdentityModule {}
