import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type {
  AccessTokenResponse,
  AuthenticatedSession,
  CurrentUser,
  LoginResponse,
  TwoFactorSetup,
} from '@samtec/contracts';
import type { Request, Response } from 'express';
import { Caller, OnKiosk, Public, type SignedInUser } from '../../common/auth.decorators.js';
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  readCookie,
  setRefreshCookie,
} from '../../common/cookies.js';
import { AppConfig } from '../../config/app-config.js';
import {
  type ChangePasswordBody,
  changePasswordSchema,
  type EnableTwoFactorBody,
  enableTwoFactorSchema,
  type LoginBody,
  loginSchema,
  type SetPasswordBody,
  setPasswordSchema,
  type TwoFactorSetupBody,
  twoFactorSetupSchema,
  type VerifyTwoFactorBody,
  verifyTwoFactorSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { type SignInPlace, signInPlace } from './sign-in-place.js';

/**
 * `/api/v1/auth/*`. Contract: the `Auth` operations in
 * packages/contracts/openapi.yaml — read those descriptions first.
 *
 * The controller handles only HTTP: request bodies, the refresh cookie and
 * status codes. Every decision lives in `AuthService`.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() request: Request,
    @Body({ schema: loginSchema }) body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.login(body.email, body.password, this.placeOf(request));
    if (outcome.kind === 'session') {
      this.rememberSession(response, outcome.refreshToken);
      return outcome.session;
    }
    return outcome.response;
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verifyTwoFactor(
    @Req() request: Request,
    @Body({ schema: verifyTwoFactorSchema }) body: VerifyTwoFactorBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedSession> {
    const result = await this.auth.verifyTwoFactor(
      body.challengeToken,
      body.code,
      this.placeOf(request),
    );
    this.rememberSession(response, result.refreshToken);
    return result.session;
  }

  @Public()
  @Post('2fa/setup')
  @HttpCode(200)
  startTwoFactorSetup(
    @Req() request: Request,
    @Body({ schema: twoFactorSetupSchema }) body: TwoFactorSetupBody,
  ): Promise<TwoFactorSetup> {
    return this.auth.startTwoFactorSetup(body.setupToken, this.placeOf(request));
  }

  @Public()
  @Post('2fa/enable')
  @HttpCode(200)
  async enableTwoFactor(
    @Req() request: Request,
    @Body({ schema: enableTwoFactorSchema }) body: EnableTwoFactorBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedSession> {
    const result = await this.auth.enableTwoFactor(
      body.setupToken,
      body.code,
      this.placeOf(request),
    );
    this.rememberSession(response, result.refreshToken);
    return result.session;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenResponse> {
    this.assertTrustedOrigin(request);
    const rotated = await this.auth.refresh(readCookie(request, REFRESH_COOKIE_NAME));
    setRefreshCookie(response, rotated.refreshToken, this.config);
    return { accessToken: rotated.accessToken, expiresInSeconds: rotated.expiresInSeconds };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.assertTrustedOrigin(request);
    await this.auth.logout(readCookie(request, REFRESH_COOKIE_NAME));
    clearRefreshCookie(response, this.config);
  }

  // The kiosk shows which ADMIN is signed in on it.
  @OnKiosk()
  @Get('me')
  me(@Caller() caller: SignedInUser): Promise<CurrentUser> {
    return this.auth.me(caller.userId);
  }

  // Public: the one-time link token in the body is the proof.
  @Public()
  @Post('set-password')
  @HttpCode(204)
  async setPassword(@Body({ schema: setPasswordSchema }) body: SetPasswordBody): Promise<void> {
    await this.auth.setPassword(body.token, body.newPassword);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Caller() caller: SignedInUser,
    @Body({ schema: changePasswordSchema }) body: ChangePasswordBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.changePassword(caller.userId, body.currentPassword, body.newPassword);
    // Every session just ended, this browser's too: forget its cookie.
    clearRefreshCookie(response, this.config);
  }

  /**
   * Refresh and logout act on a cookie the browser sends automatically, so
   * they only accept requests that really come from the dashboard: the
   * `Origin` header must be one of the addresses in `CORS_ORIGINS`. Another
   * website cannot fake that header, and cannot read or change it.
   */
  /**
   * Which kind of sign-in this is, from the address the browser says the page
   * came from (docs/plan/13 section 2). An address in neither list is refused:
   * sign-in is never open to any website.
   */
  private placeOf(request: Request): SignInPlace {
    const place = signInPlace(
      request.headers.origin,
      this.config.corsOrigins,
      this.config.kioskOrigins,
    );
    if (!place) {
      throw new ForbiddenException('This request must come from the SAMTEC dashboard or a kiosk.');
    }
    return place;
  }

  /** A dashboard sign-in is remembered in a cookie; a kiosk sign-in never is. */
  private rememberSession(response: Response, refreshToken: string | null): void {
    if (refreshToken) {
      setRefreshCookie(response, refreshToken, this.config);
    }
  }

  private assertTrustedOrigin(request: Request): void {
    const origin = request.headers.origin;
    if (!origin || !this.config.corsOrigins.includes(origin)) {
      throw new ForbiddenException('This request must come from the SAMTEC dashboard.');
    }
  }
}
