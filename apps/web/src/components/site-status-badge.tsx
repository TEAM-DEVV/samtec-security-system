import type { SiteStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';

/** Every site status, in the order the dashboard lists them. */
export const SITE_STATUSES: readonly SiteStatus[] = ['ACTIVE', 'INACTIVE'];

// `Record<SiteStatus, …>` makes TypeScript fail the build if the contract
// ever gains a status that has no label or colour here.
export const siteStatusLabels: Record<SiteStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

const statusStyles: Record<SiteStatus, string> = {
  ACTIVE:
    'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  INACTIVE: 'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function isSiteStatus(value: string): value is SiteStatus {
  return SITE_STATUSES.some((status) => status === value);
}

/** Shows a site's status as coloured text. The text matters: never rely on colour alone. */
export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', statusStyles[status])}>
      {siteStatusLabels[status]}
    </Badge>
  );
}
