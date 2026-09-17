import type { HealthResponse, SystemInfo } from '@samtec/contracts';
import { HttpResponse, http } from 'msw';
import { apiUrl } from '../helpers';

const startedAt = Date.now();

export const systemHandlers = [
  http.get(apiUrl('/health'), () =>
    HttpResponse.json<HealthResponse>({
      status: 'ok',
      time: new Date().toISOString(),
      checks: { database: 'up' },
    }),
  ),

  // The real endpoint is for ADMIN accounts only. The mock stays open until
  // the sign-in screens exist; it then starts requiring a token like the rest.
  http.get(apiUrl('/system/info'), () =>
    HttpResponse.json<SystemInfo>({
      version: '0.1.0-mock',
      environment: 'development',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  ),
];
