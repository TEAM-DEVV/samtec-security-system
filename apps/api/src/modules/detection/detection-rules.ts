import type { DetectionRuleCode, DetectionSeverity } from '../../generated/prisma/enums.js';

/**
 * The rule catalogue and the pure functions behind three of the rules
 * (docs/plan/08-ghost-detection-engine.md).
 *
 * A rule is a **pure function**: rows in, findings out. No database, no
 * clock of its own, no `this`. That is what makes each one testable on its
 * own, and what lets the report show a threshold being moved and the finding
 * changing with it.
 *
 * A rule never decides anything about a person. It says "this is worth
 * looking at", names the rows it looked at, and stops.
 */

/** What one rule found: the subject, the window and the rows it cited. */
export interface Finding {
  ruleCode: DetectionRuleCode;
  /** The rule, the subject and the window. Its uniqueness makes a sweep repeatable. */
  dedupeKey: string;
  employeeId?: string;
  deviceId?: string;
  siteId?: string;
  windowFrom: Date;
  windowTo: Date;
  evidence: Record<string, unknown>;
}

/** Every rule's name, one plain sentence, and the numbers it starts with. */
export interface RuleDefaults {
  code: DetectionRuleCode;
  name: string;
  description: string;
  severity: DetectionSeverity;
  thresholds: Record<string, number>;
  /** False until the rule is built, so an empty rule never looks like a clean bill of health. */
  built: boolean;
}

export const RULE_CATALOGUE: readonly RuleDefaults[] = [
  {
    code: 'R1',
    name: 'Duplicate enrollment',
    description: 'One face enrolled twice, under two names.',
    severity: 'CRITICAL',
    thresholds: {},
    built: false,
  },
  {
    code: 'R2',
    name: 'Identity collision',
    description: 'Two workers sharing a phone number, bank account or mobile money number.',
    severity: 'HIGH',
    thresholds: { sharedBy: 2 },
    built: false,
  },
  {
    code: 'R3',
    name: 'Paid without presence',
    description: 'A payslip paying more hours than the recorded shifts support.',
    severity: 'CRITICAL',
    thresholds: { toleranceMinutes: 60 },
    built: false,
  },
  {
    code: 'R4',
    name: 'Bilocation',
    description: 'One worker on shift at two sites at the same time, more than once.',
    severity: 'HIGH',
    thresholds: { overlaps: 3, days: 30 },
    built: true,
  },
  {
    code: 'R5',
    name: 'Never seen',
    description: 'On the books for a fortnight and never once clocked in.',
    severity: 'HIGH',
    thresholds: { days: 14 },
    built: true,
  },
  {
    code: 'R6',
    name: 'Terminated but active',
    description: 'Punches or pay after the day the worker left.',
    severity: 'CRITICAL',
    thresholds: {},
    built: false,
  },
  {
    code: 'R7',
    name: 'Fallback abuse',
    description: 'A worker, or a supervisor, leaning on the ways around the camera.',
    severity: 'MEDIUM',
    thresholds: { sharePercent: 40, days: 30, minimumClockIns: 5, supervisorCoSigns: 20 },
    built: false,
  },
  {
    code: 'R8',
    name: 'Robot regularity',
    description: 'Clock-in times too alike to be a person walking to work.',
    severity: 'MEDIUM',
    thresholds: { standardDeviationMinutes: 3, workingDays: 10 },
    built: false,
  },
  {
    code: 'R9',
    name: 'Device anomaly',
    description: 'A terminal sending far more punches than it ever has, or with a wandering clock.',
    severity: 'MEDIUM',
    thresholds: { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
    built: false,
  },
  {
    code: 'R10',
    name: 'Orphan punches',
    description: 'A device user number that matches nobody, again and again.',
    severity: 'MEDIUM',
    thresholds: { punches: 5, days: 7 },
    built: true,
  },
  {
    code: 'R11',
    name: 'Conflicted decision',
    description: 'A two-person decision settled by somebody who should not have settled it.',
    severity: 'HIGH',
    thresholds: {},
    built: false,
  },
];

/** How much an open alert of each severity adds to somebody's risk score. */
export const SEVERITY_WEIGHT: Record<DetectionSeverity, number> = {
  CRITICAL: 10,
  HIGH: 5,
  MEDIUM: 2,
};

/** The most times one rule counts towards a score, however often it fired. */
export const RECURRENCE_CAP = 5;

// --- R5 · Never seen --------------------------------------------------------

export interface WorkerOnTheBooks {
  employeeId: string;
  hireDate: Date;
  siteId?: string;
  /** How many punches this worker has ever had. */
  punches: number;
}

/**
 * **The classic ghost.** On the payroll, past the settling-in period, and
 * never once at a gate.
 *
 * The window runs from the hire date to today, because "never" is their whole
 * time here — not the last month.
 */
export function neverSeen(
  workers: readonly WorkerOnTheBooks[],
  thresholds: { days: number },
  now: Date,
): Finding[] {
  const cutoff = new Date(now.getTime() - thresholds.days * DAY_MS);
  return workers
    .filter((worker) => worker.punches === 0 && worker.hireDate <= cutoff)
    .map((worker) => ({
      ruleCode: 'R5' as const,
      // One finding per worker, ever: the answer does not change by being
      // asked again tomorrow, and a person who cleared it is not asked twice.
      dedupeKey: `R5:${worker.employeeId}`,
      employeeId: worker.employeeId,
      siteId: worker.siteId,
      windowFrom: worker.hireDate,
      windowTo: now,
      evidence: {
        daysOnTheBooks: Math.floor((now.getTime() - worker.hireDate.getTime()) / DAY_MS),
        punches: 0,
        hiredOn: isoDate(worker.hireDate),
      },
    }));
}

// --- R4 · Bilocation --------------------------------------------------------

export interface OverlapCount {
  employeeId: string;
  siteId?: string;
  overlaps: number;
  siteNames: string[];
}

/**
 * One person on shift at two places at once, **more than once**.
 *
 * Phase 2 already raises an `OVERLAP` exception for each one, and an operator
 * clears it. This rule does not repeat that: it counts them. One overlap is a
 * bad night; three in a month is a question about the person.
 */
export function bilocation(
  counts: readonly OverlapCount[],
  thresholds: { overlaps: number; days: number },
  now: Date,
): Finding[] {
  const from = new Date(now.getTime() - thresholds.days * DAY_MS);
  return counts
    .filter((row) => row.overlaps >= thresholds.overlaps)
    .map((row) => ({
      ruleCode: 'R4' as const,
      // Per worker per month: a pattern that continues is worth asking about
      // again next month, but not again tomorrow.
      dedupeKey: `R4:${row.employeeId}:${isoMonth(now)}`,
      employeeId: row.employeeId,
      siteId: row.siteId,
      windowFrom: from,
      windowTo: now,
      evidence: { overlaps: row.overlaps, sites: row.siteNames },
    }));
}

// --- R10 · Orphan punches ---------------------------------------------------

export interface OrphanCount {
  deviceId: string;
  siteId?: string;
  deviceName: string;
  punches: number;
  numbersTried: string[];
}

/**
 * A terminal reporting user numbers that match nobody, again and again.
 *
 * One is a typo or a worker enrolled on the wrong device. Five in a week is
 * either a device configured against the wrong company — or somebody trying
 * numbers to see which ones the system answers to.
 */
export function orphanPunches(
  counts: readonly OrphanCount[],
  thresholds: { punches: number; days: number },
  now: Date,
): Finding[] {
  const from = new Date(now.getTime() - thresholds.days * DAY_MS);
  return counts
    .filter((row) => row.punches >= thresholds.punches)
    .map((row) => ({
      ruleCode: 'R10' as const,
      dedupeKey: `R10:${row.deviceId}:${isoDate(now)}`,
      deviceId: row.deviceId,
      siteId: row.siteId,
      windowFrom: from,
      windowTo: now,
      evidence: {
        punches: row.punches,
        device: row.deviceName,
        // The numbers tried, which is what shows probing apart from a typo.
        numbersTried: row.numbersTried.slice(0, 20),
      },
    }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar day as `YYYY-MM-DD`, in UTC, for a dedupe key. */
function isoDate(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}

/** A calendar month as `YYYY-MM`, in UTC, for a dedupe key. */
function isoMonth(moment: Date): string {
  return moment.toISOString().slice(0, 7);
}
