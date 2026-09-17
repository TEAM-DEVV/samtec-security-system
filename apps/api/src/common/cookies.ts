import type { Request, Response } from 'express';
import type { AppConfig } from '../config/app-config.js';

/** The name of the refresh token cookie, as promised in the API contract. */
export const REFRESH_COOKIE_NAME = 'samtec_refresh';

/** How long a refresh token (and so a signed-in browser) lasts: 7 days. */
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Reads one cookie from the request, or undefined when it is not there. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        // A malformed value (bad percent-encoding) is "no cookie", not a crash.
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Sets the refresh token cookie with the attributes the contract promises:
 * unreadable by JavaScript, sent only to the auth endpoints, never sent by
 * another website, and only over HTTPS in production. (Over plain http on
 * localhost a `Secure` cookie would never be sent back, so it is off in
 * development.)
 */
export function setRefreshCookie(response: Response, token: string, config: AppConfig): void {
  response.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS * 1000,
  });
}

/** Clears the refresh token cookie. The attributes must match `setRefreshCookie`. */
export function clearRefreshCookie(response: Response, config: AppConfig): void {
  response.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
  });
}
