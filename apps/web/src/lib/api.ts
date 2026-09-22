import type { paths } from '@samtec/contracts';
import createFetchClient from 'openapi-fetch';
import createClient from 'openapi-react-query';
import { env } from './env';
import { clearSession, getSession, updateAccessToken } from './session';

/**
 * The typed HTTP client for the SAMTEC API, built from the API contract.
 * TypeScript checks every path, parameter and response against
 * packages/contracts/openapi.yaml.
 *
 * Use it for one-off calls outside React components, for example in a click handler:
 *
 *   const { data, error } = await fetchClient.GET('/employees/{employeeId}', {
 *     params: { path: { employeeId } },
 *   });
 */
export const fetchClient = createFetchClient<paths>({
  baseUrl: env.apiBaseUrl,
  // Sends the refresh-token cookie to the API.
  credentials: 'include',
  fetch: fetchWithSession,
});

/**
 * React Query hooks for every endpoint. This is how pages load data:
 *
 *   const employees = $api.useQuery('get', '/employees', {
 *     params: { query: { limit: 25 } },
 *   });
 *
 * The hook returns `data`, `error`, `isPending` and more, fully typed.
 */
export const $api = createClient(fetchClient);

/**
 * A 401 from these endpoints means "wrong password or code" or "no refresh
 * cookie", never "your access token has expired", so it must not trigger a
 * refresh. (Refreshing after a failed refresh would also loop forever.)
 */
const PATHS_THAT_NEVER_REFRESH = [
  '/auth/login',
  '/auth/2fa/verify',
  '/auth/2fa/setup',
  '/auth/2fa/enable',
  '/auth/refresh',
  '/auth/logout',
  '/auth/set-password',
];

function neverRefreshes(url: string): boolean {
  const { pathname } = new URL(url);
  return PATHS_THAT_NEVER_REFRESH.some((path) => pathname.endsWith(path));
}

/** Adds the signed-in user's access token, if there is one. Only ever to our own API. */
function withAccessToken(request: Request): Request {
  const session = getSession();
  if (session && new URL(request.url).origin === env.apiOrigin) {
    request.headers.set('Authorization', `Bearer ${session.accessToken}`);
  }
  return request;
}

/**
 * Sends every API request with the access token, and when the API answers
 * 401 because the token expired (it lasts 15 minutes), gets a new one with
 * the refresh cookie and sends the request once more. Pages never notice.
 *
 * Looked up on every request instead of once at startup, so the mock API used
 * in tests can intercept the requests.
 */
async function fetchWithSession(request: Request): Promise<Response> {
  // A request's body can be sent only once, so keep an unsent copy for the retry.
  const retry = request.clone();
  const sentWith = getSession()?.accessToken;
  const response = await globalThis.fetch(withAccessToken(request));

  if (response.status !== 401 || neverRefreshes(request.url) || sentWith === undefined) {
    return response;
  }
  // Another request may already have refreshed the token while this one was
  // out. Then there is nothing to refresh: just send again with the new token.
  if (getSession()?.accessToken === sentWith) {
    const refreshed = await refreshAccessToken();
    if (refreshed === null) {
      return response;
    }
  } else if (getSession() === null) {
    return response;
  }
  return globalThis.fetch(withAccessToken(retry));
}

let refreshInFlight: Promise<string | null> | undefined;

/**
 * Asks the API for a new access token using the refresh cookie. Returns the
 * token, or null when the API refuses (the session is over, and the local
 * session is cleared).
 *
 * Only one refresh runs at a time, in this tab and across tabs: the API
 * rotates the refresh cookie on every call and treats a second use of an old
 * cookie as theft, signing the user out everywhere. Requests that fail
 * together share one refresh, and tabs take turns through a browser-wide lock.
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= withRefreshLock(async () => {
    try {
      const { data, error, response } = await fetchClient.POST('/auth/refresh');
      if (data) {
        updateAccessToken(data.accessToken);
        return data.accessToken;
      }
      if (response.status === 403) {
        // The API did not trust this page's address: its CORS_ORIGINS setting
        // is wrong. Without this line it just looks like "sign in again" every
        // 15 minutes. The message holds no personal data or token.
        console.error('The API refused to refresh the session:', error?.detail);
      }
      if (response.status === 401 || response.status === 403) {
        clearSession();
      }
      return null;
    } catch {
      // The API could not be reached. Keep the session: it may still be valid.
      return null;
    } finally {
      refreshInFlight = undefined;
    }
  });
  return refreshInFlight;
}

const REFRESH_LOCK = 'samtec-refresh';

/**
 * Runs `refresh` while holding a lock shared by every tab of this dashboard,
 * so two tabs never send the same refresh cookie at the same moment (the
 * second one would look like a replay). The tab that waits then refreshes
 * with the rotated cookie, which the API accepts. Browsers without the Web
 * Locks API, and the test runner, simply run it straight away.
 */
function withRefreshLock<T>(refresh: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(REFRESH_LOCK, refresh) : refresh();
}
