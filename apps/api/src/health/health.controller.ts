import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse } from '@samtec/contracts';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

/**
 * `GET /api/v1/health`. Contract: operation `getHealth` in
 * packages/contracts/openapi.yaml.
 *
 * Controllers stay thin: they handle HTTP details (routes, status codes) and
 * leave the actual work to a service.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async getHealth(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const report = await this.health.check();
    // The contract says: 200 when everything works, 503 when a dependency is down.
    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
