import type { AuthenticatedSession, LoginResponse, TwoFactorChallenge } from '@samtec/contracts';
import { KioskRequestFailed } from '@/lib/api';

/**
 * The administrator's session, while they are standing at the kiosk.
 *
 * **Held in a variable and nowhere else.** Not `localStorage`, not IndexedDB, not
 * a cookie: a kiosk is a shared phone screwed to a wall, and an administrator's
 * session left behind on it is a way into everything. Closing the tab or
 * reloading the page ends it, which is the behaviour we want.
 *
 * The server agrees: a kiosk sign-in gets **no refresh token at all**, and its
 * access token lives fifteen minutes and works only on the kiosk screens. So
 * there is nothing here worth keeping even if we wanted to.
 *
 * The API decides a sign-in is a *kiosk* sign-in from the browser's `Origin`
 * header, which a page cannot forge — which is why the kiosk's address has to be
 * in `KIOSK_ORIGINS` and why the app talks to `/api/v1` on its own origin.
 *
 * Design: docs/plan/13-biometrics-design.md section 2.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/+$/, '');

/** Who is signed in at the kiosk right now. */
export interface AdminSession {
  accessToken: string;
  fullName: string;
  /** When the token stops working, so a screen can say so before a request fails. */
  expiresAt: number;
}

/** A sign-in that needs the six-digit code before it is finished. */
export interface CodeNeeded {
  challengeToken: string;
}

/** Either a finished session, or a code still to come. */
export type SignInResult = { session: AdminSession } | { codeNeeded: CodeNeeded };

/** One unsigned call to the auth endpoints. Nothing here carries a device signature. */
async function callAuth<Answer>(path: string, body: unknown, token?: string): Promise<Answer> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = answer as
      | { detail?: string; traceId?: string; errors?: { message?: string }[] }
      | undefined;
    throw new KioskRequestFailed(
      response.status,
      problem?.errors?.[0]?.message ?? problem?.detail ?? refusalFor(response.status),
      problem?.traceId,
    );
  }
  return answer as Answer;
}

/**
 * What to say when the server sent no words of its own.
 *
 * Never "no account with that email": a kiosk is in a public place, so a refusal
 * must not tell a stranger which addresses exist.
 */
function refusalFor(status: number): string {
  switch (status) {
    case 401:
      return 'That email and password do not match.';
    case 403:
      return 'Only an administrator can sign in on a kiosk.';
    case 429:
      return 'Too many tries. Wait a moment before trying again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Turns a finished sign-in into the session this app holds. */
function toSession(answer: AuthenticatedSession, at: Date): AdminSession {
  return {
    accessToken: answer.accessToken,
    fullName: answer.user.fullName,
    expiresAt: at.getTime() + answer.expiresInSeconds * 1000,
  };
}

/**
 * Step one: email and password.
 *
 * A kiosk sign-in that answers `TWO_FACTOR_SETUP_REQUIRED` is refused here
 * rather than handled. Setting up an authenticator means showing a QR code and a
 * secret key on a screen bolted to a wall in a public place, which is not
 * something a kiosk should ever do — that belongs on the dashboard.
 */
export async function signIn(
  email: string,
  password: string,
  now: Date = new Date(),
): Promise<SignInResult> {
  const answer = await callAuth<LoginResponse>('/auth/login', { email, password });
  if (answer.status === 'AUTHENTICATED') {
    return { session: toSession(answer, now) };
  }
  if (answer.status === 'TWO_FACTOR_REQUIRED') {
    return { codeNeeded: { challengeToken: (answer as TwoFactorChallenge).challengeToken } };
  }
  throw new KioskRequestFailed(
    403,
    'Set up your authenticator app on the dashboard first, not here on the kiosk.',
  );
}

/** Step two: the six-digit code from the authenticator app. */
export async function verifyCode(
  challengeToken: string,
  code: string,
  now: Date = new Date(),
): Promise<AdminSession> {
  const answer = await callAuth<AuthenticatedSession>('/auth/2fa/verify', {
    challengeToken,
    code,
  });
  return toSession(answer, now);
}

/**
 * Ends the session on the server as well as here.
 *
 * A kiosk token cannot be refreshed and dies in fifteen minutes anyway, so this
 * is belt and braces — but an administrator who walks away from a phone on a
 * wall should be able to end it themselves, now, rather than trust a clock.
 */
export async function signOut(session: AdminSession): Promise<void> {
  try {
    await callAuth<void>('/auth/logout', {}, session.accessToken);
  } catch {
    // Forgetting it here is what matters, and the caller does that regardless.
  }
}

/** True when the token has run out, so a screen can say so before a request fails. */
export function hasExpired(session: AdminSession, now: Date = new Date()): boolean {
  return now.getTime() >= session.expiresAt;
}
