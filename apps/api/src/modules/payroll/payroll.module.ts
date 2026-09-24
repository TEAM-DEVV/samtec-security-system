import { Module } from '@nestjs/common';
import { PayrollFactsService } from './payroll-facts.service.js';

/**
 * Ghanaian payroll (docs/plan/09-payroll-engine-ghana.md). It owns
 * `payroll_periods`, `payroll_runs`, `payroll_lines`, `payslips`,
 * `tax_tables`, `tax_bands`, `employee_pay_terms` and
 * `employee_payment_details`, and nothing outside it writes to them.
 *
 * **Phase 4 is still being built** (the endpoints, the payslip PDF and the
 * screens). This module exists already because Phase 5 needs the read seam
 * below: ghost detection asks what was paid, through the module that owns the
 * answer. The controller and the payroll service belong here when they land —
 * add them to `controllers` and `providers`, and leave the exported facts
 * service alone.
 *
 * Payroll imports nothing from detection, and never will: rule R3 refuses a
 * run at submission through the shared function in
 * `src/common/paid-beyond-presence.ts`, not by calling detection.
 */
@Module({
  providers: [PayrollFactsService],
  exports: [PayrollFactsService],
})
export class PayrollModule {}
