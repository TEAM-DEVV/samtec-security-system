import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { EmployeePayController } from './employee-pay.controller.js';
import { EmployeePayService } from './employee-pay.service.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollFactsService } from './payroll-facts.service.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import { TaxTablesService } from './tax-tables.service.js';

/**
 * Ghanaian payroll (docs/plan/09-payroll-engine-ghana.md). It owns
 * `payroll_periods`, `payroll_runs`, `payroll_lines`, `payslips`,
 * `tax_tables`, `tax_bands`, `employee_pay_terms` and
 * `employee_payment_details`, and nothing outside it writes to them.
 *
 * **Phase 4 is still being built.** The setup endpoints are here — the months,
 * the statutory rate versions, each worker's pay history and where their
 * salary is sent. Still to come: the run endpoints, the payslip PDF and the
 * screens.
 *
 * `PayrollFactsService` is the read seam Phase 5 needs: ghost detection asks
 * what was paid, through the module that owns the answer. It is exported and
 * nothing here changes it.
 *
 * Payroll imports nothing from detection, and never will: when the run
 * endpoints land, rule R3 will refuse a run at submission through the shared
 * function in `src/common/paid-beyond-presence.ts`, not by calling detection.
 * Nothing here calls it yet.
 */
@Module({
  imports: [IdentityModule, WorkforceModule],
  controllers: [PayrollController, EmployeePayController],
  providers: [PayrollPeriodsService, TaxTablesService, EmployeePayService, PayrollFactsService],
  exports: [PayrollPeriodsService, TaxTablesService, EmployeePayService, PayrollFactsService],
})
export class PayrollModule {}
