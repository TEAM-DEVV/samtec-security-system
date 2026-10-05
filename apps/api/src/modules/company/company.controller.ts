import { Body, Controller, Get, Put, Res } from '@nestjs/common';
import type { CompanyBankAccount } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, NeedsPassword, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { type SetBankAccountBody, setBankAccountSchema } from './company.schemas.js';
import { CompanyService } from './company.service.js';

/**
 * `/api/v1/company/*`. Contract: `getCompanyBankAccount`, `setCompanyBankAccount`.
 *
 * Reading the bank account is ADMIN and HR_PAYROLL — the same two roles the
 * bank export and the payment receipt are open to. Changing it is ADMIN only,
 * and needs a fresh password confirmation, the same control that covers
 * approving a payroll run and marking one paid.
 */
@Controller('company')
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get('bank-account')
  @Roles('ADMIN', 'HR_PAYROLL')
  async getBankAccount(
    @Caller() caller: SignedInUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CompanyBankAccount> {
    const account = await this.company.getBankAccount(caller);
    response.setHeader('Cache-Control', 'no-store');
    return account;
  }

  @NeedsPassword()
  @Put('bank-account')
  @Roles('ADMIN')
  async setBankAccount(
    @Caller() caller: SignedInUser,
    @Body({ schema: setBankAccountSchema }) body: SetBankAccountBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CompanyBankAccount> {
    const account = await this.company.setBankAccount(caller, body);
    // Carries a masked account number: a shared office computer must not keep
    // a copy of it, the same rule as the bank export and the payment details.
    response.setHeader('Cache-Control', 'no-store');
    return account;
  }
}
