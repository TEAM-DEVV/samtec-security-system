import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { CompanyModule } from '../company/company.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { EmployeePayController } from './employee-pay.controller.js';
import { EmployeePayService } from './employee-pay.service.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollApprovalService } from './payroll-approval.service.js';
import { PayrollFactsService } from './payroll-facts.service.js';
import { PayrollPeriodsService } from './payroll-periods.service.js';
import { PayrollRunsService } from './payroll-runs.service.js';
import { PayslipsController } from './payslips.controller.js';
import { PayslipsService } from './payslips.service.js';
import { TaxTablesService } from './tax-tables.service.js';

/**
 * Ghanaian payroll (docs/plan/09-payroll-engine-ghana.md). It owns
 * `payroll_periods`, `payroll_runs`, `payroll_lines`, `payslips`,
 * `tax_tables`, `tax_bands`, `employee_pay_terms` and
 * `employee_payment_details`, and nothing outside it writes to them.
 *
 * **Phase 4 is complete.** The setup endpoints (the months, the statutory rate
 * versions, each worker's pay history and where their salary is sent);
 * calculating a run and reading it back; submit, approve, reject and mark
 * paid — whoever prepared a run may approve it, password-confirmed, and rule
 * R3's gate refuses one that pays beyond presence — the payslip PDF and the
 * run summary PDF, both written by hand; the bank file; and the three
 * screens.
 *
 * `PayrollFactsService` is the read seam Phase 5 needs: ghost detection asks
 * what was paid, through the module that owns the answer. It is exported and
 * nothing here changes it.
 *
 * Payroll imports nothing from detection, and never will: the **submit**
 * endpoint refuses a run that pays beyond presence through the shared
 * function in `src/common/paid-beyond-presence.ts`
 * (`refuseHoursNobodyWorked` in `payroll-approval.service.ts`), not by
 * calling detection.
 *
 * It also imports `CompanyModule`, for the one thing the payment receipt
 * needs that payroll does not own: the company's own name and its bank
 * account, asked for through `CompanyService` rather than read off
 * `companies` directly.
 */
@Module({
  imports: [IdentityModule, CompanyModule, WorkforceModule, AttendanceModule],
  controllers: [PayrollController, PayslipsController, EmployeePayController],
  providers: [
    PayrollPeriodsService,
    TaxTablesService,
    EmployeePayService,
    PayrollRunsService,
    PayrollApprovalService,
    PayslipsService,
    PayrollFactsService,
  ],
  exports: [
    PayrollPeriodsService,
    TaxTablesService,
    EmployeePayService,
    PayrollRunsService,
    PayrollApprovalService,
    PayslipsService,
    PayrollFactsService,
  ],
})
export class PayrollModule {}
