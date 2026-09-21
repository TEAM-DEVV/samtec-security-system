import type { CurrentUser } from '@samtec/contracts';
import { useSyncExternalStore } from 'react';

/** A signed-in user and the access token that proves it to the API. */
export interface SignedInSession {
  accessToken: string;
  user: CurrentUser;
}

/**
 * A sign-in that is waiting for its second step. The token comes from
 * `POST /auth/login` and is used up by the step it was issued for.
 *
 * It lives in memory only, so a page refresh loses it. The two-factor screens
 * must send the user back to the sign-in page when it is null.
 */
export type PendingTwoFactor =
  | { step: 'VERIFY'; challengeToken: string }
  | { step: 'SETUP'; setupToken: string };

/*
 * The session lives in plain variables in this module, on purpose:
 *
 * - Memory only. The access token is never written to localStorage or
 *   sessionStorage, where any script on the page could read it. Closing the
 *   tab forgets it, and the refresh cookie (which JavaScript cannot read)
 *   signs the user in again.
 * - Outside React. The code that adds the token to every request runs outside
 *   components, so a plain variable is simpler than React context.
 *
 * Components that need to redraw when the session changes use `useSession`.
 */
let currentSession: SignedInSession | null = null;
let pendingTwoFactor: PendingTwoFactor | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getSession(): SignedInSession | null {
  return currentSession;
}

/** Remembers a finished sign-in. Any half-finished two-factor step is dropped. */
export function startSession(session: SignedInSession): void {
  currentSession = session;
  pendingTwoFactor = null;
  markSignedInOnThisBrowser(true);
  notifyListeners();
}

/*
 * A yes/no note that this browser signed in and has not signed out since. It
 * is only a hint (never a token, never who the user is): after a reload the
 * dashboard asks the API to restore the session only when the note is there,
 * so a first-time visitor is not met with a failed request. If the note is
 * ever wrong, the worst case is one extra sign-in.
 */
const SIGNED_IN_NOTE = 'samtec-signed-in';

export function mayHaveSession(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIGNED_IN_NOTE) === '1';
  } catch {
    return false;
  }
}

/**
 * Written on every sign-in and wiped on every sign-out. It never signs anyone
 * in by itself; it is exported only so tests can imitate a reload.
 */
export function markSignedInOnThisBrowser(signedIn: boolean): void {
  try {
    if (signedIn) {
      globalThis.localStorage?.setItem(SIGNED_IN_NOTE, '1');
    } else {
      globalThis.localStorage?.removeItem(SIGNED_IN_NOTE);
    }
  } catch {
    // Storage blocked (private window, strict settings): the hint is simply absent.
  }
}

/** Swaps in a fresh access token after `POST /auth/refresh`. The user stays the same. */
export function updateAccessToken(accessToken: string): void {
  if (currentSession === null) {
    return;
  }
  currentSession = { ...currentSession, accessToken };
  notifyListeners();
}

/** Forgets everything: the session, any pending two-factor step, and the signed-in note. */
export function clearSession(): void {
  currentSession = null;
  pendingTwoFactor = null;
  markSignedInOnThisBrowser(false);
  notifyListeners();
}

export function getPendingTwoFactor(): PendingTwoFactor | null {
  return pendingTwoFactor;
}

export function setPendingTwoFactor(pending: PendingTwoFactor): void {
  pendingTwoFactor = pending;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/*
 * Signing out in one tab signs out every tab: the browser tells the other tabs
 * when the note disappears, and they forget their session too. Only removal
 * counts. A note appearing is never trusted as a sign-in; the tab would still
 * have to restore through the API.
 */
globalThis.addEventListener?.('storage', (event: StorageEvent) => {
  if (event.key === SIGNED_IN_NOTE && event.newValue === null && currentSession !== null) {
    clearSession();
  }
});

/** The current session, for components. They redraw when it changes. */
export function useSession(): SignedInSession | null {
  return useSyncExternalStore(subscribe, getSession);
}
