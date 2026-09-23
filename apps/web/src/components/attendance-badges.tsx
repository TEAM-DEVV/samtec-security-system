import type {
  AttendanceExceptionStatus,
  AttendanceExceptionType,
  DeviceStatus,
  SegmentStatus,
} from '@samtec/contracts';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import {
  deviceStatusLabels,
  exceptionStatusLabels,
  exceptionTypeLabels,
  segmentStatusLabels,
} from '@/lib/attendance';

// Colours are a hint only: every badge carries its text (never colour alone).
const good =
  'border-emerald-600/25 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
const warn = 'border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
const alert = 'border-red-600/30 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200';
const quiet =
  'border-slate-400/40 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

const segmentStyles: Record<SegmentStatus, string> = {
  CONFIRMED: good,
  DISPUTED: warn,
  VOIDED: quiet,
};

export function SegmentStatusBadge({ status }: { status: SegmentStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', segmentStyles[status])}>
      {segmentStatusLabels[status]}
    </Badge>
  );
}

const exceptionTypeStyles: Record<AttendanceExceptionType, string> = {
  MISSING_CLOCK_OUT: warn,
  MISSING_CLOCK_IN: warn,
  UNKNOWN_EMPLOYEE: alert,
  INACTIVE_EMPLOYEE: alert,
  OVERLAP: alert,
  UNEXPECTED_DEVICE_ENROLLMENT: alert,
};

export function ExceptionTypeBadge({ type }: { type: AttendanceExceptionType }) {
  return (
    <Badge variant="outline" className={cn('font-medium', exceptionTypeStyles[type])}>
      {exceptionTypeLabels[type]}
    </Badge>
  );
}

const exceptionStatusStyles: Record<AttendanceExceptionStatus, string> = {
  OPEN: warn,
  RESOLVED: good,
  AUTO_CLOSED: quiet,
};

export function ExceptionStatusBadge({ status }: { status: AttendanceExceptionStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', exceptionStatusStyles[status])}>
      {exceptionStatusLabels[status]}
    </Badge>
  );
}

const deviceStyles: Record<DeviceStatus, string> = {
  ACTIVE: good,
  INACTIVE: quiet,
};

export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <Badge variant="outline" className={cn('font-medium', deviceStyles[status])}>
      {deviceStatusLabels[status]}
    </Badge>
  );
}
