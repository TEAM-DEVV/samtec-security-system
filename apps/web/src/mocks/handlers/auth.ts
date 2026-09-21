import type {
  AccessTokenResponse,
  AuthenticatedSession,
  CurrentUser,
  LoginResponse,
  TwoFactorSetup,
} from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { MOCK_PASSWORD, MOCK_TWO_FACTOR_CODE, mockUsers } from '../data/users';
import {
  apiUrl,
  type OrProblem,
  textField,
  tooManyRequests,
  unauthorized,
  validationProblem,
} from '../helpers';

const ACCESS_TOKEN_SECONDS = 900;
/** An obviously fake two-factor secret. The real API creates a new random one each time. */
const MOCK_TWO_FACTOR_SECRET = 'MOCKSECRETMOCKSECRET';
/** Like the real API: this many wrong passwords for one email lock it out… */
const MAX_PASSWORD_FAILURES = 5;
/** …for this long (15 minutes). */
const LOCK_SECONDS = 900;

type TokenPurpose = 'VERIFY' | 'SETUP';

/**
 * What the mock API remembers between requests. It stands in for the real
 * API's database and for the refresh token cookie.
 *
 * Simplified on purpose: the mock never expires tokens or lockouts, and never
 * counts wrong two-factor codes. The real API does all of these (see the contract).
 */
const memory = {
  signedInUserId: undefined as string | undefined,
  pendingTokens: new Map<string, { userId: string; purpose: TokenPurpose }>(),
  usersWhoEnabledTwoFactor: new Set<string>(),
  /** Wrong passwords per email, counted whether or not the email has an account. */
  passwordFailures: new Map<string, number>(),
};

/** Forgets every sign-in. Tests call this after each test, so tests never affect each other. */
export function resetMockSession(): void {
  memory.signedInUserId = undefined;
  memory.pendingTokens.clear();
  memory.usersWhoEnabledTwoFactor.clear();
  memory.passwordFailures.clear();
}

export const authHandlers = [
  http.post<PathParams, DefaultBodyType, OrProblem<LoginResponse>>(
    apiUrl('/auth/login'),
    async ({ request }) => {
      const body: unknown = await request.json().catch(() => undefined);
      const email = textField(body, 'email');
      const password = textField(body, 'password');
      if (!email || !password) {
        return validationProblem('email', 'Enter your email and password.');
      }

      // The lockout is checked before the password, so a locked email cannot
      // even be tested with the right password, like the real API.
      const throttleKey = email.trim().toLowerCase();
      const failures = memory.passwordFailures.get(throttleKey) ?? 0;
      if (failures >= MAX_PASSWORD_FAILURES) {
        return tooManyRequests(LOCK_SECONDS);
      }

      const found = mockUsers.find((candidate) => candidate.email === throttleKey);
      if (!found || password !== MOCK_PASSWORD) {
        memory.passwordFailures.set(throttleKey, failures + 1);
        // Never say which part was wrong, like the real API.
        return unauthorized('Email or password is incorrect.');
      }
      memory.passwordFailures.delete(throttleKey);

      const user = withCurrentTwoFactorState(found);
      if (user.twoFactorEnabled) {
        return HttpResponse.json<LoginResponse>({
          status: 'TWO_FACTOR_REQUIRED',
          challengeToken: issueToken(user, 'VERIFY'),
          expiresInSeconds: 300,
        });
      }
      if (user.role === 'ADMIN' || user.role === 'HR_PAYROLL') {
        return HttpResponse.json<LoginResponse>({
          status: 'TWO_FACTOR_SETUP_REQUIRED',
          setupToken: issueToken(user, 'SETUP'),
          expiresInSeconds: 600,
        });
      }
      return HttpResponse.json<LoginResponse>(signIn(user));
    },
  ),

  http.post<PathParams, DefaultBodyType, OrProblem<AuthenticatedSession>>(
    apiUrl('/auth/2fa/verify'),
    async ({ request }) => {
      const body: unknown = await request.json().catch(() => undefined);
      const code = textField(body, 'code');
      if (!code || !/^\d{6}$/.test(code)) {
        return validationProblem('code', 'Enter the 6-digit code from your authenticator app.');
      }
      const challengeToken = textField(body, 'challengeToken');
      const user = userForToken(challengeToken, 'VERIFY');
      if (!challengeToken || !user) {
        return unauthorized('This sign-in has expired. Sign in again.');
      }
      if (code !== MOCK_TWO_FACTOR_CODE) {
        return unauthorized('The code is incorrect.');
      }
      memory.pendingTokens.delete(challengeToken);
      return HttpResponse.json<AuthenticatedSession>(signIn(user));
    },
  ),

  http.post<PathParams, DefaultBodyType, OrProblem<TwoFactorSetup>>(
    apiUrl('/auth/2fa/setup'),
    async ({ request }) => {
      const body: unknown = await request.json().catch(() => undefined);
      const user = userForToken(textField(body, 'setupToken'), 'SETUP');
      if (!user) {
        return unauthorized('This sign-in has expired. Sign in again.');
      }
      return HttpResponse.json<TwoFactorSetup>({
        otpauthUri: `otpauth://totp/SAMTEC:${encodeURIComponent(user.email)}?secret=${MOCK_TWO_FACTOR_SECRET}&issuer=SAMTEC`,
        manualEntryKey: MOCK_TWO_FACTOR_SECRET,
      });
    },
  ),

  http.post<PathParams, DefaultBodyType, OrProblem<AuthenticatedSession>>(
    apiUrl('/auth/2fa/enable'),
    async ({ request }) => {
      const body: unknown = await request.json().catch(() => undefined);
      const code = textField(body, 'code');
      if (!code || !/^\d{6}$/.test(code)) {
        return validationProblem('code', 'Enter the 6-digit code from your authenticator app.');
      }
      const setupToken = textField(body, 'setupToken');
      const user = userForToken(setupToken, 'SETUP');
      if (!setupToken || !user) {
        return unauthorized('This sign-in has expired. Sign in again.');
      }
      if (code !== MOCK_TWO_FACTOR_CODE) {
        return unauthorized('The code is incorrect.');
      }
      memory.pendingTokens.delete(setupToken);
      memory.usersWhoEnabledTwoFactor.add(user.id);
      return HttpResponse.json<AuthenticatedSession>(signIn(withCurrentTwoFactorState(user)));
    },
  ),

  http.post<PathParams, DefaultBodyType, OrProblem<AccessTokenResponse>>(
    apiUrl('/auth/refresh'),
    () => {
      const user = mockUsers.find((candidate) => candidate.id === memory.signedInUserId);
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      return HttpResponse.json<AccessTokenResponse>({
        accessToken: accessTokenFor(user),
        expiresInSeconds: ACCESS_TOKEN_SECONDS,
      });
    },
  ),

  http.post(apiUrl('/auth/logout'), () => {
    memory.signedInUserId = undefined;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get<PathParams, DefaultBodyType, OrProblem<CurrentUser>>(
    apiUrl('/auth/me'),
    ({ request }) => {
      const authorization = request.headers.get('Authorization');
      const user = mockUsers.find(
        (candidate) => authorization === `Bearer ${accessTokenFor(candidate)}`,
      );
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      return HttpResponse.json<CurrentUser>(withCurrentTwoFactorState(user));
    },
  ),
];

function signIn(user: CurrentUser): AuthenticatedSession {
  memory.signedInUserId = user.id;
  return {
    status: 'AUTHENTICATED',
    accessToken: accessTokenFor(user),
    expiresInSeconds: ACCESS_TOKEN_SECONDS,
    user,
  };
}

/** A readable fake token. Real access tokens are signed JWTs. */
function accessTokenFor(user: CurrentUser): string {
  return `mock-access-token.${user.id}`;
}

function issueToken(user: CurrentUser, purpose: TokenPurpose): string {
  const token = `mock-${purpose.toLowerCase()}-token.${crypto.randomUUID()}`;
  memory.pendingTokens.set(token, { userId: user.id, purpose });
  return token;
}

function userForToken(token: string | undefined, purpose: TokenPurpose): CurrentUser | undefined {
  const pending = token === undefined ? undefined : memory.pendingTokens.get(token);
  if (pending?.purpose !== purpose) {
    return undefined;
  }
  return mockUsers.find((candidate) => candidate.id === pending.userId);
}

/** A user as the mock API currently knows them, including a two-factor setup done this session. */
function withCurrentTwoFactorState(user: CurrentUser): CurrentUser {
  return {
    ...user,
    twoFactorEnabled: user.twoFactorEnabled || memory.usersWhoEnabledTwoFactor.has(user.id),
  };
}
