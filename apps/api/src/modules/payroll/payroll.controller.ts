import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type {
  PayrollLineList,
  PayrollPeriod,
  PayrollPeriodList,
  PayrollRun,
  PayrollRunList,
  PayrollStatutorySummary,
  TaxTable,
  TaxTableList,
} from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  type ApproveRunBody,
  approveRunSchema,
  type CreatePeriodBody,
  type CreateRunBody,
  type CreateTaxTableBody,
  createPeriodSchema,
  createRunSchema,
  createTaxTableSchema,
  idSchema,
  type ListLinesQuery,
  type ListPeriodsQuery,
  type ListRunsQuery,
  type ListTaxTablesQuery,
  listLinesQuerySchema,
  listPeriodsQuerySchema,
  listRunsQuerySchema,
  listTaxTablesQuerySchema,
  type MarkPaidBody,
  markPaidSchema,
  type RejectRunBody,
  rejectRunSchema,
  type SubmitRunBody,
  submitRunSchema,
} from './payroll.schemas.js';
import { PayrollApprovalService } from './payroll-approval.service.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import { PayrollRunsService } from './payroll-runs.service.js';
import { TaxTablesService } from './tax-tables.service.js';

/**
 * `/api/v1/payroll/*`. Contract: the operations `listPayrollPeriods`,
 * `createPayrollPeriod`, `closePayrollPeriod`, `listPayrollRuns`,
 * `createPayrollRun`, `getPayrollRun`, `listPayrollLines`,
 * `getPayrollRunStatutorySummary`, `listTaxTables` and `createTaxTable`.
 *
 * Payroll is closed to SUPERVISOR and GUARD entirely: a supervisor runs the
 * roster and never the money, and a guard reads only their own payslip, which
 * lives on a different controller. The tax tables are narrower still — only an
 * ADMIN, because those rates decide what every worker in the company is taxed.
 */
@Controller('payroll')
@Roles('ADMIN', 'HR_PAYROLL')
export class PayrollController {
  constructor(
    private readonly periods: PayrollPeriodsService,
    private readonly taxTables: TaxTablesService,
    private readonly runs: PayrollRunsService,
    private readonly approval: PayrollApprovalService,
  ) {}

  @Get('periods')
  listPeriods(
    @Caller() caller: SignedInUser,
    @Query({ schema: listPeriodsQuerySchema }) query: ListPeriodsQuery,
  ): Promise<PayrollPeriodList> {
    return this.periods.list(caller, query);
  }

  @Post('periods')
  async createPeriod(
    @Caller() caller: SignedInUser,
    @Body({ schema: createPeriodSchema }) body: CreatePeriodBody,
    // passthrough keeps Nest in charge of the response; we only add a header.
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayrollPeriod> {
    const period = await this.periods.create(caller, body);
    response.status(201).setHeader('Location', '/api/v1/payroll/periods');
    return period;
  }

  @Post('periods/:periodId/close')
  @HttpCode(200) // A POST answers 201 by default, but nothing new is created here.
  closePeriod(
    @Caller() caller: SignedInUser,
    @Param('periodId', { schema: idSchema }) periodId: string,
  ): Promise<PayrollPeriod> {
    return this.periods.close(caller, periodId);
  }

  @Get('runs')
  listRuns(
    @Caller() caller: SignedInUser,
    @Query({ schema: listRunsQuerySchema }) query: ListRunsQuery,
  ): Promise<PayrollRunList> {
    return this.runs.list(caller, query);
  }

  @Post('runs')
  async createRun(
    @Caller() caller: SignedInUser,
    @Body({ schema: createRunSchema }) body: CreateRunBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayrollRun> {
    const run = await this.runs.create(caller, body);
    response.status(201).setHeader('Location', `/api/v1/payroll/runs/${run.id}`);
    return run;
  }

  @Get('runs/:runId')
  getRun(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
  ): Promise<PayrollRun> {
    return this.runs.get(caller, runId);
  }

  @Get('runs/:runId/lines')
  async listLines(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Query({ schema: listLinesQuerySchema }) query: ListLinesQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayrollLineList> {
    // Everybody's pay, line by line: no proxy or browser may keep a copy.
    response.setHeader('Cache-Control', 'no-store');
    return this.runs.listLines(caller, runId, query);
  }

  @Get('runs/:runId/statutory-summary')
  statutorySummary(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
  ): Promise<PayrollStatutorySummary> {
    return this.runs.statutorySummary(caller, runId);
  }

  @Post('runs/:runId/submit')
  @HttpCode(200) // Nothing new is created; the run moves forward.
  submitRun(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: submitRunSchema }) body: SubmitRunBody,
  ): Promise<PayrollRun> {
    return this.approval.submit(caller, runId, body);
  }

  // Only an ADMIN approves or rejects, and the service then refuses anybody who
  // worked on the run. Two different rules: one about the role, one about the
  // person, and the second answers 403 after the run has been found.
  @Post('runs/:runId/approve')
  @HttpCode(200)
  @Roles('ADMIN')
  approveRun(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: approveRunSchema }) body: ApproveRunBody,
  ): Promise<PayrollRun> {
    return this.approval.approve(caller, runId, body);
  }

  @Post('runs/:runId/reject')
  @HttpCode(200)
  @Roles('ADMIN')
  rejectRun(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: rejectRunSchema }) body: RejectRunBody,
  ): Promise<PayrollRun> {
    return this.approval.reject(caller, runId, body);
  }

  @Post('runs/:runId/mark-paid')
  @HttpCode(200)
  @Roles('ADMIN')
  markRunPaid(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: markPaidSchema }) body: MarkPaidBody,
  ): Promise<PayrollRun> {
    return this.approval.markPaid(caller, runId, body);
  }

  /**
   * The bank file. It carries every worker's account number, so it is a
   * download rather than JSON, it is never cached, and asking for it is audited.
   */
  @Get('runs/:runId/bank-export')
  async bankExport(
    @Caller() caller: SignedInUser,
    @Param('runId', { schema: idSchema }) runId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.approval.bankExport(caller, runId);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }

  @Get('tax-tables')
  @Roles('ADMIN')
  listTaxTables(
    @Caller() caller: SignedInUser,
    @Query({ schema: listTaxTablesQuerySchema }) query: ListTaxTablesQuery,
  ): Promise<TaxTableList> {
    return this.taxTables.list(caller, query);
  }

  @Post('tax-tables')
  @Roles('ADMIN')
  async createTaxTable(
    @Caller() caller: SignedInUser,
    @Body({ schema: createTaxTableSchema }) body: CreateTaxTableBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TaxTable> {
    const table = await this.taxTables.create(caller, body);
    response.status(201).setHeader('Location', '/api/v1/payroll/tax-tables');
    return table;
  }
}
