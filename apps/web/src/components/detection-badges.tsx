import type { DetectionAlertStatus, DetectionRuleCode, DetectionSeverity } from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { alertStatusLabels, ruleLabels, severityLabels } from '@/lib/detection';

// The same four tones as attendance-badges.tsx, so the two queues read
// alike. Colours are a hint only: every badge carries its text.
const good =
  'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
const warn = 'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
const alert = 'border-red-600/30 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200';
const quiet =
  'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

const severityStyles: Record<DetectionSeverity, string> = {
  CRITICAL: alert,
  HIGH: warn,
  MEDIUM: quiet,
};

export function SeverityBadge({ severity }: { severity: DetectionSeverity }) {
  return (
    <Badge variant="outline" className={cn('font-medium', severityStyles[severity])}>
      {severityLabels[severity]}
    </Badge>
  );
}

const statusStyles: Record<DetectionAlertStatus, string> = {
  OPEN: warn,
  UNDER_REVIEW: warn,
  RESOLVED: good,
  CONFIRMED_FRAUD: alert,
};

export function AlertStatusBadge({ status }: { status: DetectionAlertStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', statusStyles[status])}>
      {alertStatusLabels[status]}
    </Badge>
  );
}

/** The rule's code and short name together, for example "R5 · Never seen". */
export function RuleBadge({ code }: { code: DetectionRuleCode }) {
  return (
    <Badge variant="outline" className="font-medium">
      <span className="font-mono">{code}</span>
      <span aria-hidden="true"> · </span>
      {ruleLabels[code]}
    </Badge>
  );
}
