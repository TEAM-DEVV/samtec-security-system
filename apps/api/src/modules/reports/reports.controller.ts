import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { ReportsOverview } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { type AttendanceReportQuery, attendanceReportQuerySchema } from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

/**
 * `/api/v1/reports`. Contract: `getReportsOverview`,
 * `downloadAttendanceReport` and `downloadPayrollCostReport`.
 *
 * A SUPERVISOR reads the attendance figures, because they already read the
 * attendance board. They are refused the payroll cost, because a supervisor sees
 * no payroll anywhere in this system. A GUARD is refused every company figure:
 * their own payslips are the only thing here that is theirs.
 *
 * Both downloads carry `Cache-Control: no-store`. Neither names anybody's pay,
 * but both are a picture of the whole company, and a shared office computer
 * should not keep a copy of one.
 */
@Controller('reports')
@Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  overview(@Caller() caller: SignedInUser): Promise<ReportsOverview> {
    return this.reports.overview(caller);
  }

  @Get('attendance.csv')
  async attendance(
    @Caller() caller: SignedInUser,
    @Query({ schema: attendanceReportQuerySchema }) query: AttendanceReportQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.reports.attendanceCsv(caller, query);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }

  // Payroll cost is payroll, so a supervisor is refused it here even though
  // they may read the attendance report above.
  @Get('payroll-cost.csv')
  @Roles('ADMIN', 'HR_PAYROLL')
  async payrollCost(
    @Caller() caller: SignedInUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.reports.payrollCostCsv(caller);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }
}
