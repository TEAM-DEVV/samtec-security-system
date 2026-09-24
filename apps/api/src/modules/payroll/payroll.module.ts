import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { EmployeePayController } from './employee-pay.controller.js';
import { EmployeePayService } from './employee-pay.service.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import { TaxTablesService } from './tax-tables.service.js';

/**
 * The payroll module (Phase 4). It owns `payroll_periods`, `payroll_runs`,
 * `payroll_lines`, `payslips`, `tax_tables`, `tax_bands`,
 * `employee_pay_terms` and `employee_payment_details`, and writes to nothing
 * else: it asks the workforce module about people and the attendance module
 * about confirmed shifts.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md. The rules and the file layout
 * are in `README.md` beside this file.
 */
@Module({
  imports: [IdentityModule, WorkforceModule],
  controllers: [PayrollController, EmployeePayController],
  providers: [PayrollPeriodsService, TaxTablesService, EmployeePayService],
  exports: [PayrollPeriodsService, TaxTablesService, EmployeePayService],
})
export class PayrollModule {}
