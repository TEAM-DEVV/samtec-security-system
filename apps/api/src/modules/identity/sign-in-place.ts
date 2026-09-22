/**
 * Where a sign-in is happening: the dashboard, or a kiosk at a site
 * (docs/plan/13-biometrics-design.md section 2).
 *
 * The browser sets the `Origin` header itself and a page cannot change it, so
 * the address the request came from is what decides. The two lists of
 * addresses never overlap (the API refuses to start if they do), so exactly
 * one answer is possible.
 *
 * A kiosk is a shared device: its sign-in gets no refresh cookie, and its
 * token only works on the kiosk screens.
 */
export type SignInPlace = 'DASHBOARD' | 'KIOSK';

/** Which of the two lists this address is in, or null for anywhere else. */
export function signInPlace(
  origin: string | undefined,
  dashboardOrigins: readonly string[],
  kioskOrigins: readonly string[],
): SignInPlace | null {
  if (origin === undefined || origin === '') {
    return null;
  }
  if (dashboardOrigins.includes(origin)) {
    return 'DASHBOARD';
  }
  if (kioskOrigins.includes(origin)) {
    return 'KIOSK';
  }
  return null;
}

/**
 * A sign-in takes two or three steps, so the token that carries a half-done
 * sign-in remembers where it started. The letter travels with the token, and
 * the database stores the hash of the whole thing, so changing the letter
 * simply makes the token unknown.
 */
export function stampPlace(place: SignInPlace, token: string): string {
  return `${place === 'KIOSK' ? 'k' : 'd'}.${token}`;
}

/** Where the token was issued, or null when it does not say. */
export function placeOfToken(token: string): SignInPlace | null {
  if (token.startsWith('k.')) {
    return 'KIOSK';
  }
  if (token.startsWith('d.')) {
    return 'DASHBOARD';
  }
  return null;
}
