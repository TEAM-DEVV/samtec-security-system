import type { EmployeeStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';

/** Every employee status, in the order the dashboard lists them. */
export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = [
  'ACTIVE',
  'PENDING_ENROLLMENT',
  'SUSPENDED',
  'TERMINATED',
];

// `Record<EmployeeStatus, ...>` makes TypeScript fail the build if the contract
// ever gains a status that has no label or colour here.
export const employeeStatusLabels: Record<EmployeeStatus, string> = {
  ACTIVE: 'Active',
  PENDING_ENROLLMENT: 'Pending enrollment',
  SUSPENDED: 'Suspended',
  TERMINATED: 'Terminated',
};

const statusStyles: Record<EmployeeStatus, string> = {
  ACTIVE:
    'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  PENDING_ENROLLMENT:
    'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  SUSPENDED:
    'border-orange-600/30 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  TERMINATED:
    'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function isEmployeeStatus(value: string): value is EmployeeStatus {
  return EMPLOYEE_STATUSES.some((status) => status === value);
}

/** Shows an employee's status as coloured text. The text matters: never rely on colour alone. */
export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', statusStyles[status])}>
      {employeeStatusLabels[status]}
    </Badge>
  );
}
