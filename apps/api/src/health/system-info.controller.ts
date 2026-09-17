import { Controller, Get } from '@nestjs/common';
import type { SystemInfo } from '@samtec/contracts';
import { Roles } from '../common/auth.decorators.js';
import { AppConfig } from '../config/app-config.js';

/**
 * `GET /api/v1/system/info`. Contract: operation `getSystemInfo`.
 *
 * The public `/health` endpoint deliberately reveals nothing about the
 * system, so administrators read the version, environment and uptime here.
 */
@Controller('system')
export class SystemInfoController {
  constructor(private readonly config: AppConfig) {}

  @Get('info')
  @Roles('ADMIN')
  getSystemInfo(): SystemInfo {
    return {
      version: this.config.version,
      environment: this.config.nodeEnv,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
