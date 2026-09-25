import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Reports (Phase 6): the figures a manager reads at a glance, and the files they
 * take away.
 *
 * **It owns no tables.** Every figure is counted from the tables the screens
 * already read, so a report can never disagree with the page beside it. That is
 * why this module reads widely and writes nothing at all.
 */
@Module({
  imports: [IdentityModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
