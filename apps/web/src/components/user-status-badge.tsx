import type { UserAccountStatus } from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';

// `Record<UserAccountStatus, …>` makes TypeScript fail the build if the
// contract ever gains a status that has no label or colour here.
export const userStatusLabels: Record<UserAccountStatus, string> = {
  AWAITING_PASSWORD: 'Awaiting password',
  ACTIVE: 'Active',
  DEACTIVATED: 'Switched off',
};

/** One plain sentence per status, for the account page. */
export const userStatusDescriptions: Record<UserAccountStatus, string> = {
  AWAITING_PASSWORD: 'Waiting for the person to choose a password with their one-time link.',
  ACTIVE: 'Can sign in.',
  DEACTIVATED: 'Cannot sign in. Nothing is deleted; switch it back on at any time.',
};

const statusStyles: Record<UserAccountStatus, string> = {
  ACTIVE:
    'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  AWAITING_PASSWORD:
    'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  DEACTIVATED:
    'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

/** Shows a sign-in account's status as coloured text. The text matters: never rely on colour alone. */
export function UserStatusBadge({ status }: { status: UserAccountStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', statusStyles[status])}>
      {userStatusLabels[status]}
    </Badge>
  );
}
