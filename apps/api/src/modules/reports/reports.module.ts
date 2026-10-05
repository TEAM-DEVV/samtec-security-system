import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { SiteInvoicesController } from './site-invoices.controller.js';
import { SiteInvoicesService } from './site-invoices.service.js';

/**
 * Reports (Phase 6): the figures a manager reads at a glance, and the files they
 * take away.
 *
 * **It owns no tables.** Every figure is counted from the tables the screens
 * already read, so a report can never disagree with the page beside it. That is
 * why this module reads widely and writes nothing at all.
 *
 * The client invoice needs the workforce module (for the site and the
 * worker names) and the attendance module (for the hours), so reports
 * imports both — imports still point one way only, attendance → workforce →
 * identity, and nothing imports reports back.
 */
@Module({
  imports: [IdentityModule, WorkforceModule, AttendanceModule],
  controllers: [ReportsController, SiteInvoicesController],
  providers: [ReportsService, SiteInvoicesService],
  exports: [ReportsService],
})
export class ReportsModule {}
