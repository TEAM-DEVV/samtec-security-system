import type {
  AttemptOutcome,
  CollisionStatus,
  ExemptionStatus,
  FaceStatus,
  PunchMethod,
} from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { isFlaggedMethod, punchMethodLabels } from '@/lib/attendance';
import {
  attemptOutcomeLabels,
  collisionStatusLabels,
  exemptionStatusLabels,
  faceStatusLabels,
  isWorryingOutcome,
} from '@/lib/biometrics';

// Colours are a hint only: every badge carries its text (never colour alone).
const good =
  'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
const warn = 'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
const alert = 'border-red-600/30 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200';
const quiet =
  'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

/** How the clock-in was proved. The flagged methods (a typed number, a co-sign) are amber. */
export function PunchMethodBadge({ method }: { method: PunchMethod }) {
  const flagged = isFlaggedMethod(method);
  return (
    <Badge variant="outline" className={cn('font-medium', flagged ? warn : good)}>
      {punchMethodLabels[method]}
      {flagged && <span className="sr-only"> (does not prove who was there)</span>}
    </Badge>
  );
}

const faceStyles: Record<FaceStatus, string> = {
  NONE: quiet,
  PENDING: warn,
  ACTIVE: good,
  BLOCKED: alert,
  REVOKED: quiet,
};

export function FaceStatusBadge({ status }: { status: FaceStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', faceStyles[status])}>
      {faceStatusLabels[status]}
    </Badge>
  );
}

const exemptionStyles: Record<ExemptionStatus, string> = {
  REQUESTED: warn,
  APPROVED: good,
  REJECTED: quiet,
  ENDED: quiet,
};

export function ExemptionStatusBadge({ status }: { status: ExemptionStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', exemptionStyles[status])}>
      {exemptionStatusLabels[status]}
    </Badge>
  );
}

export function AttemptOutcomeBadge({ outcome }: { outcome: AttemptOutcome }) {
  return (
    <Badge
      variant="outline"
      className={cn('font-medium', isWorryingOutcome(outcome) ? warn : good)}
    >
      {attemptOutcomeLabels[outcome]}
    </Badge>
  );
}

const collisionStyles: Record<CollisionStatus, string> = {
  OPEN: warn,
  RESOLVED: good,
};

export function CollisionStatusBadge({ status }: { status: CollisionStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', collisionStyles[status])}>
      {collisionStatusLabels[status]}
    </Badge>
  );
}
