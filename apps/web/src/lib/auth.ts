import { fetchClient, refreshAccessToken } from './api';
import { clearSession, startSession } from './session';

/**
 * Brings a signed-in user back after a page reload. The access token lives in
 * memory only, so a reload loses it; the refresh cookie (which the browser
 * keeps) gets a new one, and `GET /auth/me` says who the user is.
 *
 * Returns false when there is no usable refresh cookie: the user must sign in.
 */
export function restoreSession(): Promise<boolean> {
  // One restore at a time: React runs effects twice in development, and two
  // guards could mount together. They all share the same attempt.
  restoreInFlight ??= (async () => {
    try {
      const accessToken = await refreshAccessToken();
      if (accessToken === null) {
        return false;
      }
      const me = await fetchClient.GET('/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!me.data) {
        return false;
      }
      startSession({ accessToken, user: me.data });
      return true;
    } finally {
      restoreInFlight = undefined;
    }
  })();
  return restoreInFlight;
}

let restoreInFlight: Promise<boolean> | undefined;

/**
 * Signs out: the API revokes the refresh cookie, and the dashboard forgets the
 * session. The local part happens even if the API cannot be reached, so the
 * user is never stuck signed in on this device.
 */
export async function signOut(): Promise<void> {
  try {
    await fetchClient.POST('/auth/logout');
  } catch {
    // The API could not be reached. The cookie stays valid until it expires,
    // but this device forgets the session either way.
  } finally {
    clearSession();
  }
}
