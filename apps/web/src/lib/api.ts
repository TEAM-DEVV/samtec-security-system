import type { paths } from '@samtec/contracts';
import createFetchClient from 'openapi-fetch';
import createClient from 'openapi-react-query';
import { env } from './env';

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
  // Sends the refresh-token cookie to the API (needed from Phase 1).
  credentials: 'include',
  // Look up `fetch` on every request instead of once at startup, so the mock
  // API used in tests can intercept the requests.
  fetch: (request) => globalThis.fetch(request),
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
