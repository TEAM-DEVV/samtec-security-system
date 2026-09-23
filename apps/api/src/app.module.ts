import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { DetectionModule } from './modules/detection/detection.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { UsersModule } from './modules/identity/users.module.js';
import { WorkforceModule } from './modules/workforce/workforce.module.js';

/**
 * The root module: it wires the whole API together.
 *
 * Feature modules (attendance, payroll, detection and reporting) are added to
 * `imports` as each roadmap phase builds them. See src/modules/README.md.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    IdentityModule,
    WorkforceModule,
    UsersModule,
    AttendanceModule,
    DetectionModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
