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
 * Dashboard settings, read once from Vite.
 *
 * Only variables that start with `VITE_` reach the browser, and anything in the
 * browser is public, so never put secrets here.
 */
export const env = {
  apiBaseUrl: toApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  /**
   * True when the dashboard runs with pretend data (`pnpm dev:web`). It is
   * always false in a production build (`import.meta.env.DEV` is false there),
   * so the mock API can never reach real users.
   */
  useMocks: import.meta.env.DEV && import.meta.env.MODE === 'mock',
} as const;
