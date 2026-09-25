import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Payslip, PayslipList } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { AuditService } from '../identity/audit.service.js';
import { idSchema, type ListPayslipsQuery, listPayslipsQuerySchema } from './payroll.schemas.js';
import { PayslipsService } from './payslips.service.js';

/**
 * `/api/v1/payroll/payslips`. Contract: `listPayslips`, `getPayslip` and
 * `downloadPayslipPdf`.
 *
 * **This is the one payroll controller a GUARD may reach**, and only for their
 * own payslips. That is why the roles here are wider than everywhere else in
 * payroll, and why the service — not this file — decides which records the
 * caller may see. A SUPERVISOR is still refused: a supervisor runs the roster
 * and has no business in anybody's pay.
 *
 * Every answer carries `Cache-Control: no-store`. A payslip is somebody's
 * salary, and a shared office computer must not keep a copy of it.
 */
@Controller('payroll/payslips')
@Roles('ADMIN', 'HR_PAYROLL', 'GUARD')
export class PayslipsController {
  constructor(
    private readonly payslips: PayslipsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listPayslipsQuerySchema }) query: ListPayslipsQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayslipList> {
    response.setHeader('Cache-Control', 'no-store');
    return this.payslips.list(caller, query);
  }

  @Get(':payslipId')
  get(
    @Caller() caller: SignedInUser,
    @Param('payslipId', { schema: idSchema }) payslipId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Payslip> {
    response.setHeader('Cache-Control', 'no-store');
    return this.payslips.get(caller, payslipId);
  }

  /**
   * The stored file, byte for byte.
   *
   * Downloading it is audited: a payslip is the record of what somebody was
   * paid, and who read one is worth knowing. The entry names the payslip and
   * the worker it belongs to, and no figure from it.
   */
  @Get(':payslipId/pdf')
  async pdf(
    @Caller() caller: SignedInUser,
    @Param('payslipId', { schema: idSchema }) payslipId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.payslips.pdf(caller, payslipId);
    await this.audit.record({
      companyId: caller.companyId,
      actorUserId: caller.userId,
      action: 'payroll.payslip_downloaded',
      entityType: 'payslip',
      entityId: payslipId,
      detail: { employeeId: file.employeeId, ownPayslip: caller.employeeId === file.employeeId },
    });
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(file.bytes), {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }
}
