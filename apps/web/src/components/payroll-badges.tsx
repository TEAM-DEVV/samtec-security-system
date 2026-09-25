import type { PayrollPeriodStatus, PayrollRunStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { periodStatusLabels, runStatusLabels, runStatusTone } from '@/lib/payroll';

// The same four tones as attendance-badges.tsx and detection-badges.tsx, so
// every queue in the dashboard reads alike. Colour is a hint only: every badge
// carries its own words, because a payroll state is not something to guess at.
const good =
  'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
const warn = 'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
const alert = 'border-red-600/30 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200';
const quiet =
  'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

const toneStyles = { neutral: quiet, waiting: warn, good, ended: alert } as const;

/** Where a run has got to: a draft, waiting on somebody, approved, paid or sent back. */
export function RunStatusBadge({ status }: { status: PayrollRunStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', toneStyles[runStatusTone[status]])}>
      {runStatusLabels[status]}
    </Badge>
  );
}

/** Whether a payroll month is still open, or closed for good. */
export function PeriodStatusBadge({ status }: { status: PayrollPeriodStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', status === 'OPEN' ? good : quiet)}>
      {periodStatusLabels[status]}
    </Badge>
  );
}
