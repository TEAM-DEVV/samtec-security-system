import type { Prisma } from '../../generated/prisma/client.js';
import type { EmployeeStatus } from '../../generated/prisma/enums.js';
import type { EmployeesService } from '../workforce/employees.service.js';

/**
 * Where a worker stands after their face has gone (docs/plan/13 section 2).
 *
 * A worker can be at work on either of two footings: a face that passed the
 * duplicate check, or an exemption two ADMINs approved. Losing the first one
 * never takes the second: an exemption is what the law leaves a worker who
 * cannot or will not give biometrics, and one ADMIN must never be able to
 * undo what two of them agreed.
 *
 * So: the worker stops counting as enrolled, and then, if an approved
 * exemption is still in force, they stand on that instead and keep working
 * by a supervisor's co-sign. Only somebody with neither goes back to waiting.
 */
export async function standDown(
  tx: Prisma.TransactionClient,
  employees: EmployeesService,
  companyId: string,
  employeeId: string,
): Promise<EmployeeStatus> {
  const waiting = await employees.clearBiometricsEnrolled(companyId, employeeId, tx);
  const exemption = await tx.biometricExemption.findFirst({
    where: { companyId, employeeId, status: 'APPROVED' },
    select: { id: true },
  });
  if (!exemption) {
    return waiting;
  }
  return employees.activateWithoutBiometrics(companyId, employeeId, tx);
}
