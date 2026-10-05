import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CompanyController } from './company.controller.js';
import { CompanyService } from './company.service.js';

/**
 * The company's own record: its name, and the bank account its payroll is
 * paid from (`bank_name`, `branch`, `account_name` and `account_number` on
 * `companies`). A module of its own, following the house rule that a module
 * writes only to its own tables — `payroll` asks `CompanyService` for the
 * paying account on the payment receipt rather than reading those columns
 * itself.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
