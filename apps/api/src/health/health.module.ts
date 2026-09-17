import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { SystemInfoController } from './system-info.controller.js';

@Module({
  controllers: [HealthController, SystemInfoController],
  providers: [HealthService],
})
export class HealthModule {}
