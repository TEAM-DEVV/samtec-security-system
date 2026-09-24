import { Body, Controller, Get, HttpCode, Param, Put, Query, Res } from '@nestjs/common';
import type {
  EmployeePaymentDetails,
  EmployeePayTerms,
  EmployeePayTermsList,
} from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { EmployeePayService } from './employee-pay.service.js';
import {
  idSchema,
  type ListPayTermsQuery,
  listPayTermsQuerySchema,
  type SetPaymentDetailsBody,
  type SetPayTermsBody,
  setPaymentDetailsSchema,
  setPayTermsSchema,
} from './payroll.schemas.js';

/**
 * `/api/v1/employees/{employeeId}/pay-terms` and `.../payment-details`.
 * Contract: `listEmployeePayTerms`, `setEmployeePayTerms` and
 * `setEmployeePaymentDetails`.
 *
 * These hang off an employee rather than off `/payroll`, because they belong
 * to a person rather than to a month — but they are payroll data, owned by the
 * payroll module, so the controller lives here and not in workforce.
 *
 * A GUARD may read their own payslips but not their own pay terms, and never
 * their payment details: a shared kiosk screen must not be one tap away from
 * somebody's bank account number.
 */
@Controller('employees')
@Roles('ADMIN', 'HR_PAYROLL')
export class EmployeePayController {
  constructor(private readonly pay: EmployeePayService) {}

  @Get(':employeeId/pay-terms')
  listPayTerms(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Query({ schema: listPayTermsQuerySchema }) query: ListPayTermsQuery,
  ): Promise<EmployeePayTermsList> {
    return this.pay.listPayTerms(caller, employeeId, query);
  }

  @Put(':employeeId/pay-terms')
  @HttpCode(201) // A PUT answers 200 by default, but this adds a row and changes none.
  setPayTerms(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: setPayTermsSchema }) body: SetPayTermsBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EmployeePayTerms> {
    response.setHeader('Location', `/api/v1/employees/${employeeId}/pay-terms`);
    return this.pay.setPayTerms(caller, employeeId, body);
  }

  @Put(':employeeId/payment-details')
  async setPaymentDetails(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: setPaymentDetailsSchema }) body: SetPaymentDetailsBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EmployeePaymentDetails> {
    // Personal data: no browser or proxy may keep a copy of this answer.
    response.setHeader('Cache-Control', 'no-store');
    return this.pay.setPaymentDetails(caller, employeeId, body);
  }
}
