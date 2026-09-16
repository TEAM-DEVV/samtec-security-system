import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * The root module: it wires the whole API together.
 *
 * Feature modules (identity, workforce, attendance, payroll, detection and
 * reporting) are added to `imports` as each roadmap phase builds them.
 * See src/modules/README.md.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
