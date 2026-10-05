import type { HealthResponse } from '@samtec/contracts';
import { HttpResponse, http } from 'msw';
import { apiUrl } from '../helpers';

export const systemHandlers = [
  http.get(apiUrl('/health'), () =>
    HttpResponse.json<HealthResponse>({
      status: 'ok',
      time: new Date().toISOString(),
      checks: { database: 'up' },
    }),
  ),
];
