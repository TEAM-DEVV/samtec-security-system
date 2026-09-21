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
  notifyListeners();
}

/** Swaps in a fresh access token after `POST /auth/refresh`. The user stays the same. */
export function updateAccessToken(accessToken: string): void {
  if (currentSession === null) {
    return;
  }
  currentSession = { ...currentSession, accessToken };
  notifyListeners();
}

/** Forgets everything: the session and any pending two-factor step. */
export function clearSession(): void {
  currentSession = null;
  pendingTwoFactor = null;
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

/** The current session, for components. They redraw when it changes. */
export function useSession(): SignedInSession | null {
  return useSyncExternalStore(subscribe, getSession);
}
