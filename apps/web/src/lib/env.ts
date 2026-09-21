const DEFAULT_API_BASE_URL = 'http://localhost:3000/api/v1';

/**
 * Cleans up the configured API address. An empty value counts as not set, and
 * trailing slashes are removed, so request URLs never look like `/api/v1//health`.
 */
export function toApiBaseUrl(configured: string | undefined): string {
  const value = configured?.trim();
  return (value ? value : DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

/**
 * The website the API lives on, for example `http://localhost:3000`. The
 * address may be relative (`/api/v1` on the TEST deployment, where the
 * dashboard forwards API calls to its own address), so it is resolved against
 * the page's own address.
 */
export function toApiOrigin(apiBaseUrl: string, pageOrigin: string): string {
  return new URL(apiBaseUrl, pageOrigin).origin;
}

/**
 * Dashboard settings, read once from Vite.
 *
 * Only variables that start with `VITE_` reach the browser, and anything in the
 * browser is public, so never put secrets here.
 */
export const env = {
  apiBaseUrl: toApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  /** Only requests to this website ever carry the access token. */
  apiOrigin: toApiOrigin(
    toApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
    globalThis.location?.origin ?? 'http://localhost',
  ),
  /**
   * True when the dashboard runs with pretend data (`pnpm dev:web`). It is
   * always false in a production build (`import.meta.env.DEV` is false there),
   * so the mock API can never reach real users.
   */
  useMocks: import.meta.env.DEV && import.meta.env.MODE === 'mock',
} as const;
