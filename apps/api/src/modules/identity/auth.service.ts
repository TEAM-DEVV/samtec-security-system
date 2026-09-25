import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthenticatedSession,
  CurrentUser,
  TwoFactorChallenge,
  TwoFactorSetup,
  TwoFactorSetupRequired,
} from '@samtec/contracts';
import { REFRESH_COOKIE_MAX_AGE_SECONDS } from '../../common/cookies.js';
import { normalizeEmail } from '../../common/emails.js';
import { RateLimitException } from '../../common/rate-limit.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthChallenge, User } from '../../generated/prisma/client.js';
import { awaitsAdminConfirmation, mayUseAccount } from './account-rules.js';
import { AccountsService } from './accounts.service.js';
import { AuditService } from './audit.service.js';
import { hashPassword, NO_SUCH_USER_HASH, verifyPassword } from './password.js';
import { placeOfToken, type SignInPlace, stampPlace } from './sign-in-place.js';
import { SignInThrottleService } from './sign-in-throttle.service.js';
import { ACCESS_TOKEN_SECONDS, TokensService } from './tokens.service.js';
import { generateTotpSecret, otpauthUri, verifyTotpCode } from './totp.js';

/** A password challenge (enter your code) lasts 5 minutes. */
const CHALLENGE_MINUTES = 5;
/** A two-factor setup (scan the QR code) gets a little longer: 10 minutes. */
const SETUP_MINUTES = 10;
/** This many wrong codes cancel the challenge; sign in with the password again. */
const MAX_CODE_ATTEMPTS = 5;

/** The one message for every way a sign-in can be wrong, so nothing is revealed. */
const WRONG_CREDENTIALS = 'Email or password is incorrect.';
/** The one message for every dead or foreign challenge token. */
const CHALLENGE_GONE = 'This sign-in has expired. Sign in with your password again.';
/** The one message for every dead, used or foreign password link. */
const LINK_GONE = 'This link has expired or was already used. Ask an administrator for a new one.';
/** A half-done sign-in is finished where it started, never moved across. */
const WRONG_PLACE = 'Finish signing in where you started.';
/** A kiosk stands at a guard post: only enrollment happens there. */
const KIOSK_ADMINS_ONLY = 'Only an administrator signs in on a kiosk.';
const AWAITING_SECOND_ADMIN =
  'A second administrator must confirm this account before it can be used.';

/** What `login` can decide. The controller turns each kind into its HTTP shape. */
export type LoginOutcome =
  | { kind: 'session'; session: AuthenticatedSession; refreshToken: string | null }
  | { kind: 'challenge'; response: TwoFactorChallenge }
  | { kind: 'setup'; response: TwoFactorSetupRequired };

export interface RotatedSession {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
}

/**
 * All the sign-in flows, exactly as the contract describes them. Read the
 * contract's `/auth/*` descriptions first; this file is those promises as code.
 *
 * Guessing is throttled twice, on purpose:
 * - wrong **passwords** are counted per email (`password` throttle), and
 * - wrong **two-factor codes** are counted per account (`totp` throttle).
 * The second one matters: signing in again issues a fresh challenge, but
 * never fresh code attempts — so even someone who knows the password cannot
 * grind through the million possible 6-digit codes.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly throttle: SignInThrottleService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async login(rawEmail: string, password: string, place: SignInPlace): Promise<LoginOutcome> {
    const email = normalizeEmail(rawEmail);
    await this.throttle.assertNotLocked('password', email);

    const user = await this.prisma.user.findFirst({ where: { email } });
    // When the email has no account (or the account is still waiting for its
    // owner to choose a password), still check the password against a
    // stand-in hash: every case then costs the same time, so response timing
    // cannot reveal which emails have accounts.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? NO_SUCH_USER_HASH);
    if (!user || user.passwordHash === null || !passwordOk || !user.isActive) {
      const lockedNow = await this.throttle.recordFailure('password', email);
      if (lockedNow && user) {
        await this.recordLockout(user, 'password');
      }
      throw new UnauthorizedException(WRONG_CREDENTIALS);
    }
    await this.throttle.recordSuccess('password', email);

    // A kiosk stands at a guard post: only an ADMIN has anything to do on it
    // (docs/plan/13 section 2), so nobody else may start a session there.
    if (place === 'KIOSK' && user.role !== 'ADMIN') {
      throw new ForbiddenException(KIOSK_ADMINS_ONLY);
    }
    // Only after the password was right, so the answer reveals nothing to a
    // stranger. Before two-factor setup too: a held account sets nothing up.
    if (awaitsAdminConfirmation(user)) {
      throw new ForbiddenException(AWAITING_SECOND_ADMIN);
    }

    if (user.twoFactorEnabledAt) {
      // A locked-out authenticator answers 429 here already, instead of
      // issuing a challenge that could only fail.
      await this.throttle.assertNotLocked('totp', user.id);
      const challengeToken = await this.issueChallenge(
        user,
        'VERIFY_CODE',
        CHALLENGE_MINUTES,
        place,
      );
      return {
        kind: 'challenge',
        response: {
          status: 'TWO_FACTOR_REQUIRED',
          challengeToken,
          expiresInSeconds: CHALLENGE_MINUTES * 60,
        },
      };
    }

    if (user.role === 'ADMIN' || user.role === 'HR_PAYROLL') {
      // Two-factor is set up on the dashboard only, so the secret never
      // appears on a screen everyone at the site can see.
      if (place === 'KIOSK') {
        throw new ForbiddenException(
          'Set up two-factor sign-in on the dashboard before using a kiosk.',
        );
      }
      const setupToken = await this.issueChallenge(user, 'SET_UP', SETUP_MINUTES, place);
      return {
        kind: 'setup',
        response: {
          status: 'TWO_FACTOR_SETUP_REQUIRED',
          setupToken,
          expiresInSeconds: SETUP_MINUTES * 60,
        },
      };
    }

    return { kind: 'session', ...(await this.establishSession(user, place)) };
  }

  /** Step two of signing in for accounts that already use an authenticator app. */
  async verifyTwoFactor(
    challengeToken: string,
    code: string,
    place: SignInPlace,
  ): Promise<{ session: AuthenticatedSession; refreshToken: string | null }> {
    const { challenge, user } = await this.loadChallenge(challengeToken, 'VERIFY_CODE', place);
    // Take the attempt **before** the code is judged. A plain "are you locked
    // out?" read let a thousand requests sent at the same moment all see "not
    // locked" and all have their code checked, which turns 5 guesses every 15
    // minutes into a thousand.
    await this.claimCodeAttempt(user);
    const secret = user.twoFactorSecretEncrypted
      ? this.tokens.decryptSecret(user.twoFactorSecretEncrypted)
      : null;
    if (!secret) {
      throw new UnauthorizedException(CHALLENGE_GONE);
    }

    const matchedStep = await this.checkCode(
      challenge,
      user,
      secret,
      code,
      user.twoFactorLastUsedStep,
    );
    await this.prisma.authChallenge.delete({ where: { id: challenge.id } });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorLastUsedStep: BigInt(matchedStep) },
    });
    return this.establishSession(user, place);
  }

  /** Creates a fresh authenticator secret for the QR code. Enabling comes next. */
  async startTwoFactorSetup(setupToken: string, place: SignInPlace): Promise<TwoFactorSetup> {
    const { challenge, user } = await this.loadChallenge(setupToken, 'SET_UP', place);
    const secret = generateTotpSecret();
    // The secret waits on the challenge until the user proves their app works.
    // Calling setup again simply replaces it, as the contract says.
    await this.prisma.authChallenge.update({
      where: { id: challenge.id },
      data: { pendingSecretEncrypted: this.tokens.encryptSecret(secret) },
    });
    return { otpauthUri: otpauthUri(user.email, secret), manualEntryKey: secret };
  }

  /** The first correct code proves the app was set up; two-factor turns on. */
  async enableTwoFactor(
    setupToken: string,
    code: string,
    place: SignInPlace,
  ): Promise<{ session: AuthenticatedSession; refreshToken: string | null }> {
    const { challenge, user } = await this.loadChallenge(setupToken, 'SET_UP', place);
    await this.claimCodeAttempt(user);
    if (!challenge.pendingSecretEncrypted) {
      throw new BadRequestException('Call POST /auth/2fa/setup first to get your QR code.');
    }
    const secret = this.tokens.decryptSecret(challenge.pendingSecretEncrypted);
    if (!secret) {
      throw new UnauthorizedException(CHALLENGE_GONE);
    }

    const matchedStep = await this.checkCode(challenge, user, secret, code, null);
    await this.prisma.authChallenge.delete({ where: { id: challenge.id } });
    const enabledUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecretEncrypted: challenge.pendingSecretEncrypted,
        twoFactorEnabledAt: new Date(),
        twoFactorLastUsedStep: BigInt(matchedStep),
      },
    });
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: user.id,
      action: 'auth.two_factor_enabled',
      entityType: 'user',
      entityId: user.id,
    });
    return this.establishSession(enabledUser, place);
  }

  /**
   * Swaps a refresh token for a fresh access token, rotating the refresh
   * token itself. A refresh token that was already rotated must never appear
   * again — if it does, someone copied it, and every session of that user is
   * revoked so both the thief and the user are signed out everywhere.
   *
   * A session that simply ended (signed out, or ended by an administrator)
   * is different: it has no replacement, so it answers 401 without raising
   * the alarm — otherwise an admin action would sign the person out of the
   * session they create next.
   */
  async refresh(refreshToken: string | undefined): Promise<RotatedSession> {
    if (!refreshToken) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: this.tokens.hashToken(refreshToken) },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    if (session.revokedAt) {
      if (session.replacedById) {
        await this.handleRefreshReuse(session.userId, session.user.companyId);
      }
      throw new UnauthorizedException('Sign in to continue.');
    }
    if (!mayUseAccount(session.user)) {
      // Switched off, reset, or an office role without two-factor: end this
      // session too, so nothing stays alive for later.
      await this.prisma.userSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sign in to continue.');
    }

    // "Claim" the token atomically: only the request that flips revokedAt
    // from null wins, and the same write records the replacement. Two
    // requests racing with the same token would otherwise both pass the check
    // above and both mint sessions — exactly the replay rotation catches.
    const next = await this.createSessionRow(session.userId);
    const claimed = await this.prisma.userSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.sessionId },
    });
    if (claimed.count === 0) {
      await this.handleRefreshReuse(session.userId, session.user.companyId);
    }
    return {
      accessToken: await this.tokens.signAccessToken(this.asSignedIn(session.user)),
      expiresInSeconds: ACCESS_TOKEN_SECONDS,
      refreshToken: next.refreshToken,
    };
  }

  /** Revokes the refresh token, if one was sent. Signing out never fails. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) {
      return;
    }
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: this.tokens.hashToken(refreshToken) },
      include: { user: true },
    });
    if (!session || session.revokedAt) {
      return;
    }
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      companyId: session.user.companyId,
      actorUserId: session.userId,
      action: 'auth.signed_out',
      entityType: 'user',
      entityId: session.userId,
    });
  }

  /** The signed-in user, fresh from the database (roles can change). */
  async me(userId: string): Promise<CurrentUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !mayUseAccount(user)) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    return toCurrentUser(user);
  }

  /**
   * The person chooses their own password with the one-time link an
   * administrator gave them. The link works once: claiming it deletes it, in
   * the same transaction that saves the password.
   */
  async setPassword(token: string, newPassword: string): Promise<void> {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { tokenHash: this.tokens.hashToken(token) },
      include: { user: true },
    });
    if (
      challenge?.purpose !== 'SET_PASSWORD' ||
      challenge.expiresAt < new Date() ||
      !challenge.user.isActive
    ) {
      throw linkGone();
    }
    // Hash before the transaction: scrypt is slow on purpose, and a
    // transaction should never wait on it.
    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.authChallenge.deleteMany({ where: { id: challenge.id } });
      if (claimed.count === 0) {
        throw linkGone(); // Another request used the link a moment ago.
      }
      await tx.user.update({ where: { id: challenge.userId }, data: { passwordHash } });
      await this.accounts.endAllAccess(challenge.userId, tx);
      await this.audit.record(
        {
          companyId: challenge.user.companyId,
          actorUserId: challenge.userId,
          action: 'auth.password_set',
          entityType: 'user',
          entityId: challenge.userId,
        },
        tx,
      );
    });
    // A fresh password deserves a fresh start: forget earlier wrong guesses.
    await this.throttle.recordSuccess('password', challenge.user.email);
  }

  /**
   * Changes the caller's own password. A wrong current password answers 400
   * (not 401, so the dashboard does not try a refresh) and counts towards the
   * same per-email lockout as signing in. Success ends every session.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !mayUseAccount(user) || user.passwordHash === null) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    await this.throttle.assertNotLocked('password', user.email);

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      const lockedNow = await this.throttle.recordFailure('password', user.email);
      if (lockedNow) {
        await this.recordLockout(user, 'password');
      }
      throw fieldProblem('currentPassword', 'Your current password is incorrect.');
    }
    if (newPassword === currentPassword) {
      throw fieldProblem('newPassword', 'Choose a password different from your current one.');
    }
    await this.throttle.recordSuccess('password', user.email);

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await this.accounts.endAllAccess(user.id, tx);
      await this.audit.record(
        {
          companyId: user.companyId,
          actorUserId: user.id,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------

  /** A rotated token came back: sign this user out everywhere and record it. */
  private async handleRefreshReuse(userId: string, companyId: string): Promise<never> {
    await this.accounts.endAllAccess(userId);
    await this.audit.record({
      companyId,
      actorUserId: userId,
      action: 'auth.refresh_reuse_detected',
      entityType: 'user',
      entityId: userId,
      detail: { revokedAllSessions: true },
    });
    throw new UnauthorizedException('Sign in to continue.');
  }

  /**
   * Starts a session. A kiosk is a shared device, so a kiosk sign-in gets **no
   * refresh session at all**: nobody stays signed in on it, and its access
   * token dies within 15 minutes and works only on the kiosk screens.
   */
  private async establishSession(
    user: User,
    place: SignInPlace,
  ): Promise<{ session: AuthenticatedSession; refreshToken: string | null }> {
    const onKiosk = place === 'KIOSK';
    // Checked here, not only at the password step: every sign-in, however many
    // steps it took, ends up in this one place.
    if (onKiosk && user.role !== 'ADMIN') {
      throw new ForbiddenException(KIOSK_ADMINS_ONLY);
    }
    const refreshToken = onKiosk ? null : (await this.createSessionRow(user.id)).refreshToken;
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: user.id,
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: user.id,
      detail: { place },
    });
    return {
      session: {
        status: 'AUTHENTICATED',
        accessToken: await this.tokens.signAccessToken({ ...this.asSignedIn(user), onKiosk }),
        expiresInSeconds: ACCESS_TOKEN_SECONDS,
        user: toCurrentUser(user),
      },
      refreshToken,
    };
  }

  private async createSessionRow(
    userId: string,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const refreshToken = this.tokens.newOpaqueToken();
    const row = await this.prisma.userSession.create({
      data: {
        userId,
        tokenHash: this.tokens.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_SECONDS * 1000),
      },
    });
    return { sessionId: row.id, refreshToken };
  }

  /** Issues a one-time token for the next sign-in step, replacing older ones. */
  private async issueChallenge(
    user: User,
    purpose: 'VERIFY_CODE' | 'SET_UP',
    minutes: number,
    place: SignInPlace,
  ): Promise<string> {
    await this.prisma.authChallenge.deleteMany({ where: { userId: user.id, purpose } });
    const token = stampPlace(place, this.tokens.newOpaqueToken());
    await this.prisma.authChallenge.create({
      data: {
        userId: user.id,
        purpose,
        tokenHash: this.tokens.hashToken(token),
        expiresAt: new Date(Date.now() + minutes * 60_000),
      },
    });
    return token;
  }

  /** Finds a live challenge for this token, or answers 401 without saying why. */
  private async loadChallenge(
    token: string,
    purpose: 'VERIFY_CODE' | 'SET_UP',
    place: SignInPlace,
  ): Promise<{ challenge: AuthChallenge; user: User }> {
    // A sign-in started on a kiosk is finished on that kiosk, and one started
    // on the dashboard on the dashboard. The token says which.
    const started = placeOfToken(token);
    if (started === null) {
      throw new UnauthorizedException(CHALLENGE_GONE);
    }
    if (started !== place) {
      throw new ForbiddenException(WRONG_PLACE);
    }
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { tokenHash: this.tokens.hashToken(token) },
      include: { user: true },
    });
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      challenge.expiresAt < new Date() ||
      challenge.failedAttempts >= MAX_CODE_ATTEMPTS ||
      !challenge.user.isActive
    ) {
      throw new UnauthorizedException(CHALLENGE_GONE);
    }
    return { challenge, user: challenge.user };
  }

  /**
   * Checks a 6-digit code. The attempt was already taken from the account's
   * `totp` throttle by the caller (5 every 15 minutes, counted and judged in
   * the one statement), which is what stops someone who has the password from
   * grinding codes — across fresh challenges, or a thousand at a time on one.
   * A right answer hands the slate back; a wrong one also counts against this
   * challenge, and 5 cancel it. A code at or before the last accepted step is
   * a replay and is refused. Returns the step the code matched.
   */
  private async checkCode(
    challenge: AuthChallenge,
    user: User,
    secret: string,
    code: string,
    lastUsedStep: bigint | null,
  ): Promise<number> {
    const matchedStep = verifyTotpCode(secret, code);
    if (matchedStep !== null && (lastUsedStep === null || BigInt(matchedStep) > lastUsedStep)) {
      await this.throttle.recordSuccess('totp', user.id);
      return matchedStep;
    }

    // `increment` makes the database do the +1, so parallel wrong codes are
    // all counted instead of overwriting each other.
    const updated = await this.prisma.authChallenge.update({
      where: { id: challenge.id },
      data: { failedAttempts: { increment: 1 } },
    });

    if (updated.failedAttempts >= MAX_CODE_ATTEMPTS) {
      throw new UnauthorizedException(CHALLENGE_GONE);
    }
    if (matchedStep !== null) {
      throw new UnauthorizedException('That code was already used. Wait for the next one.');
    }
    throw new UnauthorizedException('The code is incorrect.');
  }

  /**
   * Takes one of this account's five code attempts, and records the lockout
   * when that was the last of them.
   */
  private async claimCodeAttempt(user: User): Promise<void> {
    try {
      await this.throttle.claimAttempt('totp', user.id);
    } catch (error) {
      if (error instanceof RateLimitException && error.justLocked) {
        await this.recordLockout(user, 'totp');
      }
      throw error;
    }
  }

  /** A lockout is worth remembering: it may be the start of an attack. */
  private async recordLockout(user: User, kind: 'password' | 'totp'): Promise<void> {
    await this.audit.record({
      companyId: user.companyId,
      actorUserId: null,
      action: 'auth.lockout_triggered',
      entityType: 'user',
      entityId: user.id,
      detail: { kind },
    });
  }

  private asSignedIn(user: User) {
    return {
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
      employeeId: user.employeeId,
      // Refreshing only ever happens on the dashboard (the kiosk has no cookie).
      onKiosk: false,
    };
  }
}

/** A 400 that points at one request field, in the same shape as validation errors. */
function fieldProblem(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: [{ path: [path], message }] });
}

function linkGone(): BadRequestException {
  return fieldProblem('token', LINK_GONE);
}

/** Maps a database user to the contract's `CurrentUser` shape. */
export function toCurrentUser(user: User): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    twoFactorEnabled: user.twoFactorEnabledAt !== null,
    employeeId: user.employeeId,
  };
}
