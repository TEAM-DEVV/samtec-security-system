import type { DetectionAlertStatus, DetectionRuleCode, DetectionSeverity } from '@samtec/contracts';
import { formatMinutes } from '@/lib/format';

/**
 * Plain words for the ghost-detection engine's codes
 * (docs/plan/08-ghost-detection-engine.md). Each `Record<…>` makes TypeScript
 * fail the build if the contract gains a value without a label.
 */

export const ALERT_STATUSES: readonly DetectionAlertStatus[] = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED',
  'CONFIRMED_FRAUD',
];

export const alertStatusLabels: Record<DetectionAlertStatus, string> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  RESOLVED: 'Resolved',
  CONFIRMED_FRAUD: 'Confirmed fraud',
};

export const SEVERITIES: readonly DetectionSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM'];

export const severityLabels: Record<DetectionSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
};

export const RULE_CODES: readonly DetectionRuleCode[] = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
];

/** The short name of each rule, for a badge. The API sends the full name and description too. */
export const ruleLabels: Record<DetectionRuleCode, string> = {
  R1: 'Duplicate enrollment',
  R2: 'Identity collision',
  R3: 'Paid without presence',
  R4: 'Bilocation',
  R5: 'Never seen',
  R6: 'Terminated but active',
  R7: 'Fallback abuse',
  R8: 'Robot regularity',
  R9: 'Device anomaly',
  R10: 'Orphan punches',
  R11: 'Conflicted decision',
};

/**
 * The question each alert puts to a person. A rule never decides anything:
 * it asks, and somebody with the evidence in front of them answers.
 */
export const ruleQuestions: Record<DetectionRuleCode, string> = {
  R1: 'Is this face already enrolled under another name?',
  R2: 'Do these workers really share this detail, or is one of them not a separate person?',
  R3: 'Was this worker really on shift for the hours this payslip pays?',
  R4: 'Can one person have been at both sites at the same time?',
  R5: 'Has this worker ever come to work?',
  R6: 'Why is somebody who has left still on a device, or on a payslip?',
  R7: 'Why does this worker, or this supervisor, keep going round the camera?',
  R8: 'Can a person really arrive at the same minute every day?',
  R9: 'Why did this terminal behave unlike itself?',
  R10: 'Who keeps trying a number that matches nobody at this terminal?',
  R11: 'Should this person have been the one to decide this?',
};

/** What closing an alert one way or the other means. */
export const closingLabels: Record<'RESOLVED' | 'CONFIRMED_FRAUD', string> = {
  RESOLVED: 'Resolved — looked into, and there is an honest explanation',
  CONFIRMED_FRAUD: 'Confirmed fraud — hand it to management',
};

/** Plain words for the numbers a rule uses. A name not listed here is shown as it is. */
export const thresholdLabels: Record<string, string> = {
  sharedBy: 'Shared by at least (people)',
  toleranceMinutes: 'Tolerance (minutes a period)',
  overlaps: 'Overlaps before asking',
  days: 'Window (days)',
  sharePercent: 'Flagged share (%)',
  minimumClockIns: 'Minimum clock-ins',
  supervisorCoSigns: 'Supervisor co-signs in the window',
  standardDeviationMinutes: 'Spread under (minutes)',
  workingDays: 'Working days needed',
  volumeMultiple: 'Times the usual volume',
  medianDays: 'History (days)',
  clockDriftMinutes: 'Clock drift over (minutes)',
};

/**
 * Plain words for what a rule cited. Each rule's evidence shape is pinned by
 * a test on the API; anything not listed here is shown by its name, spaced
 * out, so a new key never hides.
 */
const evidenceLabels: Record<string, string> = {
  daysOnTheBooks: 'Days on the books',
  punches: 'Punches',
  hiredOn: 'Hired on',
  overlaps: 'Overlapping shifts',
  sites: 'Sites',
  numbersTried: 'Numbers tried',
  device: 'Device',
  lookedLikeStaffNumber: 'Looked like',
  similarity: 'Similarity',
  credentialId: 'Enrollment record',
  withStaffNumbers: 'Shared with',
  shares: 'What is shared',
  people: 'People sharing it',
  punchesThatDay: 'Punches that day',
  medianPunches: 'Usual punches a day',
  multiple: 'Times the usual',
  deviceName: 'Device',
  clockIns: 'Clock-ins',
  flagged: 'Flagged clock-ins',
  sharePercent: 'Share flagged (%)',
  coSigned: 'Co-signed',
  as: 'Counted as',
  days: 'Days looked at',
  spreadMinutes: 'Spread (minutes)',
  usualTime: 'Usual time',
  clockDriftMinutes: 'Clock drift (minutes)',
  fast: 'Clock runs fast',
  decision: 'Decision',
  recordId: 'Record',
  alsoDid: 'The decider had already',
  concerningEmployeeIds: 'Concerning',
  decidedByUserId: 'Decided by (user ID)',
  period: 'Pay period',
  runId: 'Payroll run',
  lineId: 'Payslip line',
  paidMinutes: 'Hours paid',
  presentMinutes: 'Hours on shift',
  beyondToleranceMinutes: 'Unexplained',
  manualMinutes: 'Of which added by hand',
  fallbackMinutes: 'Of which PIN or co-sign',
  leftOn: 'Left on',
  punchesAfter: 'Punches after leaving',
  lastPunchOn: 'Last punch',
  paidPeriodsAfter: 'Paid for',
};

export function isAlertStatus(value: string): value is DetectionAlertStatus {
  return ALERT_STATUSES.some((status) => status === value);
}

export function isSeverity(value: string): value is DetectionSeverity {
  return SEVERITIES.some((severity) => severity === value);
}

export function isRuleCode(value: string): value is DetectionRuleCode {
  return RULE_CODES.some((code) => code === value);
}

/** The label for one piece of evidence: the plain words, or the key spaced out. */
export function evidenceLabel(key: string): string {
  const known = evidenceLabels[key];
  if (known) {
    return known;
  }
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One piece of evidence as text. Minutes read as hours and minutes; a list reads as a list. */
export function evidenceText(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    if (!key.endsWith('Minutes')) {
      return String(value);
    }
    // Whole minutes read as hours and minutes. Some rules measure to a tenth
    // of a minute (R8's spread, R9's clock drift), which formatMinutes
    // rightly refuses, so those read as they are.
    return Number.isInteger(value) && value >= 0 ? formatMinutes(value) : `${value} min`;
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => String(item)).join(', ');
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}
