import { createHmac } from 'node:crypto';
import { paidBeyondPresence } from '../../common/paid-beyond-presence.js';
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
    built: true,
  },
  {
    code: 'R2',
    name: 'Identity collision',
    description: 'Two workers sharing a phone number, bank account or mobile money number.',
    severity: 'HIGH',
    thresholds: { sharedBy: 2 },
    built: true,
  },
  {
    code: 'R3',
    name: 'Paid without presence',
    description: 'A payslip paying more hours than the recorded shifts support.',
    severity: 'CRITICAL',
    thresholds: { toleranceMinutes: 60 },
    built: true,
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
    built: true,
  },
  {
    code: 'R7',
    name: 'Fallback abuse',
    description: 'A worker, or a supervisor, leaning on the ways around the camera.',
    severity: 'MEDIUM',
    thresholds: { sharePercent: 40, days: 30, minimumClockIns: 5, supervisorCoSigns: 20 },
    built: true,
  },
  {
    code: 'R8',
    name: 'Robot regularity',
    description: 'Clock-in times too alike to be a person walking to work.',
    severity: 'MEDIUM',
    thresholds: { standardDeviationMinutes: 3, workingDays: 10 },
    built: true,
  },
  {
    code: 'R9',
    name: 'Device anomaly',
    description: 'A terminal sending far more punches than it ever has, or with a wandering clock.',
    severity: 'MEDIUM',
    thresholds: { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
    built: true,
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
    built: true,
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

// --- R1 · Duplicate enrollment ---------------------------------------------

export interface OpenCollision {
  credentialId: string;
  employeeId: string;
  siteId?: string;
  lookedLikeStaffNumber: string;
  similarity: number;
  enrolledAt: Date;
}

/**
 * One face, two names — the same person enrolled twice.
 *
 * Phase 3 already refuses to match a face that collided until a second ADMIN
 * decides, so nobody clocks in on it. This rule does not repeat that
 * decision: it puts the waiting question where an investigator sees it,
 * because a duplicate enrollment that nobody ever looks at is a ghost with a
 * face.
 */
export function duplicateEnrollment(
  collisions: readonly OpenCollision[],
  _thresholds: Record<string, number>,
  now: Date,
): Finding[] {
  return collisions.map((collision) => ({
    ruleCode: 'R1' as const,
    // One per face record, ever: it is one question about one enrollment.
    dedupeKey: `R1:${collision.credentialId}`,
    employeeId: collision.employeeId,
    siteId: collision.siteId,
    windowFrom: collision.enrolledAt,
    windowTo: now,
    evidence: {
      // The staff number and the score, which is what the duplicate queue
      // already shows an ADMIN. Never a template and never an image.
      lookedLikeStaffNumber: collision.lookedLikeStaffNumber,
      similarity: collision.similarity,
      credentialId: collision.credentialId,
    },
  }));
}

// --- R2 · Identity collision -------------------------------------------------

export interface SharedDetail {
  kind: 'phone';
  value: string;
  employeeIds: string[];
  staffNumbers: string[];
}

/**
 * Two workers who share a detail only one person should have.
 *
 * The Ghana Card number is already a hard database rule, so it can never
 * happen. A shared phone can be innocent — a family, one handset between
 * two brothers — which is exactly why this raises a question rather than an
 * accusation. Version 1 checks the phone; the bank account and mobile money
 * number join it when payroll stores them.
 */
export function identityCollision(
  shared: readonly SharedDetail[],
  thresholds: { sharedBy: number },
  now: Date,
  /** The server's own key, so the fingerprint below cannot be looked up. */
  fingerprintKey: Buffer,
): Finding[] {
  return shared
    .filter((detail) => detail.employeeIds.length >= thresholds.sharedBy)
    .flatMap((detail) =>
      // One finding per worker, so each person's own file shows it, but all
      // of them naming the same group.
      detail.employeeIds.map((employeeId) => ({
        ruleCode: 'R2' as const,
        dedupeKey: `R2:${detail.kind}:${employeeId}:${fingerprintOf(detail.value, fingerprintKey)}`,
        employeeId,
        windowFrom: now,
        windowTo: now,
        evidence: {
          shares: detail.kind,
          withStaffNumbers: detail.staffNumbers,
          people: detail.employeeIds.length,
        },
      })),
    );
}

// --- R7 · Fallback abuse -----------------------------------------------------

export interface ClockInMix {
  employeeId: string;
  siteId?: string;
  clockIns: number;
  /** A supervisor's co-sign, or a staff number and any finger on the kiosk. */
  flagged: number;
}

export interface SupervisorCoSigns {
  employeeId: string;
  siteId?: string;
  coSigns: number;
}

/**
 * Somebody going around the camera, again and again.
 *
 * Every way past a face is recorded and flagged already; what matters is the
 * **share**. A guard whose face fails now and then is a guard with a bad
 * camera angle. A guard who almost never uses their face is a guard whose
 * face may not be theirs.
 *
 * It counts both ends: the worker who is let in, and the supervisor doing
 * the letting in — because the supervisor is the likelier of the two to be
 * selling it.
 */
export function fallbackAbuse(
  workers: readonly ClockInMix[],
  supervisors: readonly SupervisorCoSigns[],
  thresholds: {
    sharePercent: number;
    days: number;
    minimumClockIns: number;
    supervisorCoSigns: number;
  },
  now: Date,
): Finding[] {
  const from = new Date(now.getTime() - thresholds.days * DAY_MS);
  const month = isoMonth(now);
  const byWorker = workers
    .filter((worker) => worker.clockIns > 0 && worker.clockIns >= thresholds.minimumClockIns)
    .filter((worker) => (worker.flagged * 100) / worker.clockIns > thresholds.sharePercent)
    .map((worker) => ({
      ruleCode: 'R7' as const,
      dedupeKey: `R7:worker:${worker.employeeId}:${month}`,
      employeeId: worker.employeeId,
      siteId: worker.siteId,
      windowFrom: from,
      windowTo: now,
      evidence: {
        clockIns: worker.clockIns,
        flagged: worker.flagged,
        sharePercent: Math.round((worker.flagged * 100) / worker.clockIns),
      },
    }));
  const bySupervisor = supervisors
    .filter((supervisor) => supervisor.coSigns > thresholds.supervisorCoSigns)
    .map((supervisor) => ({
      ruleCode: 'R7' as const,
      dedupeKey: `R7:supervisor:${supervisor.employeeId}:${month}`,
      employeeId: supervisor.employeeId,
      siteId: supervisor.siteId,
      windowFrom: from,
      windowTo: now,
      evidence: { coSigned: supervisor.coSigns, as: 'supervisor' },
    }));
  return [...byWorker, ...bySupervisor];
}

/**
 * A short fingerprint of a detail, for a dedupe key.
 *
 * The key has to change when the shared number changes, but it must not be a
 * second place a worker's phone number is written down. A **plain** hash
 * would not do that: every Ghanaian mobile number fits in a table anybody
 * could build in a second, so a bare SHA-256 of one is the number itself
 * with extra steps.
 *
 * Keyed with the server's own secret, it cannot be looked up by anyone
 * holding only the rows.
 */
function fingerprintOf(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
}

// --- R11 · Conflicted decision ------------------------------------------------

export interface TwoPersonDecision {
  kind: 'duplicate review' | 'exemption';
  /** The record or request that was decided. */
  recordId: string;
  /** Everybody the decision was about: one worker, or the two in a duplicate review. */
  employeeIds: string[];
  /** The worker the alert is filed against. */
  subjectEmployeeId: string;
  decidedByUserId: string;
  decidedAt: Date;
}

/** Who already had a hand in a worker's biometrics, and how. */
export interface HandsOn {
  employeeId: string;
  userId: string;
  /** What they did: enrolled a face, wiped one, or recorded a withdrawal. */
  did: 'enrolled' | 'wiped' | 'withdrew';
  /** When. A hand the decision itself made is not a hand they had **before** it. */
  at: Date;
}

/**
 * A two-person decision settled by somebody with a hand in it already.
 *
 * **This one is expected to fire**, and it is worth being clear why, because
 * it is easy to read it the wrong way round.
 *
 * The direct links are refused outright: a database CHECK stops an ADMIN
 * deciding the review of a face they enrolled themselves, and the service
 * stops anybody who wiped a face for either worker, or recorded their
 * withdrawal. Those are never allowed, so a finding pointing at one means
 * something is wrong with **this system** — a migration or a repair script
 * that went round the rules.
 *
 * The **indirect** link is a different thing, and it is allowed on purpose.
 * An ADMIN who enrolled the *other* worker's face may still decide the
 * review, because refusing that would deadlock a company with two ADMINs in
 * the ordinary case — two brothers enrolled by different people
 * (docs/plan/13 §2, decision 13). Those decisions are **flagged, not
 * blocked**, and showing them to the payroll checker is the whole job of
 * this rule. A finding there is routine and worth a look; it is not a bug
 * report.
 *
 * **Phase 7 adds a third link: the decider's own account.** An
 * administrator who created or confirmed somebody's administrator account
 * chose who "the other administrator" would be. If that same person had also
 * handled this worker, then the two-person rule was satisfied by two accounts
 * and one pair of hands. Nothing refuses that — it cannot be refused without
 * deadlocking small companies — so it is flagged here, which is what
 * docs/plan/06 means by watching what the two-administrator rule cannot stop.
 *
 * What it never is, in any of the three cases, is a finding about the worker.
 * Nobody is accused of anything by a rule about who signed a form.
 */
export function conflictedDecision(
  decisions: readonly TwoPersonDecision[],
  hands: readonly HandsOn[],
  _thresholds: Record<string, number>,
  now: Date,
  /**
   * Who made each decider's own administrator account: the administrator who
   * asked for it and the one who confirmed it (docs/plan/06, "Two
   * administrators"). Empty for an account nobody else made.
   */
  accountsMadeBy: ReadonlyMap<string, readonly string[]> = new Map(),
): Finding[] {
  const byEmployee = new Map<string, HandsOn[]>();
  for (const hand of hands) {
    byEmployee.set(hand.employeeId, [...(byEmployee.get(hand.employeeId) ?? []), hand]);
  }
  return decisions.flatMap((decision) => {
    const handsOnEither = decision.employeeIds
      .flatMap((employeeId) => byEmployee.get(employeeId) ?? [])
      // **Only a hand somebody had before.** Settling a duplicate as one
      // person wipes the losing record, stamped with the decider's own name
      // in the same breath as the decision — so without this, every
      // by-the-book resolution would report itself, and the rule would be
      // noise within a week.
      .filter((hand) => hand.at.getTime() < decision.decidedAt.getTime());
    const clashes = handsOnEither.filter((hand) => hand.userId === decision.decidedByUserId);
    // **The second person may not be a second person.** An administrator who
    // created or confirmed the decider's account chose who "the other
    // administrator" would be; if that same administrator handled this
    // worker, the two-person rule was two accounts and one hand
    // (docs/plan/06, "Two administrators"). Phase 7 records that, so the
    // clause docs/plan/08 §9 left out is now here.
    const madeThisAccount = accountsMadeBy.get(decision.decidedByUserId) ?? [];
    const throughTheAccount = handsOnEither.filter(
      (hand) => hand.userId !== decision.decidedByUserId && madeThisAccount.includes(hand.userId),
    );
    if (clashes.length === 0 && throughTheAccount.length === 0) {
      return [];
    }
    const cited = [...clashes, ...throughTheAccount];
    return [
      {
        ruleCode: 'R11' as const,
        // One per decision, ever: it is one question about one record, and
        // the answer cannot change by asking again.
        dedupeKey: `R11:${decision.kind === 'exemption' ? 'exemption' : 'review'}:${decision.recordId}`,
        employeeId: decision.subjectEmployeeId,
        windowFrom: cited.reduce(
          (earliest, hand) => (hand.at < earliest ? hand.at : earliest),
          decision.decidedAt,
        ),
        windowTo: now,
        evidence: {
          decision: decision.kind,
          recordId: decision.recordId,
          // What the same person had already done. Never their name: an
          // alert about a decision is not a file on the person who made it.
          alsoDid: [...new Set(clashes.map((hand) => hand.did))].sort(),
          // The same, for whoever made the decider's own account — the
          // clause that tells one person with two accounts from two people.
          accountMadeByWhoAlsoDid: [...new Set(throughTheAccount.map((hand) => hand.did))].sort(),
          // **Which worker** the earlier involvement was with. On a duplicate
          // review the alert lands on one file while the history may be with
          // the other, and a checker cannot act on an alert that does not say
          // which.
          concerningEmployeeIds: [...new Set(cited.map((hand) => hand.employeeId))].sort(),
          decidedByUserId: decision.decidedByUserId,
        },
      },
    ];
  });
}

// --- R8 · Robot regularity ---------------------------------------------------

export interface ClockInTimes {
  employeeId: string;
  siteId?: string;
  /** Minutes past midnight, one per working day, Accra time. */
  minutesOfDay: number[];
}

/**
 * Clock-in times too alike to be a person walking to work.
 *
 * A real guard arrives at 05:52, then 06:04, then 05:58 — traffic, a
 * tro-tro, a child to drop off. A row of punches all within a minute of each
 * other is the signature of somebody generating them, or of one person
 * clocking in for a whole shift at once.
 *
 * It needs enough days to mean anything: a fortnight of identical arrivals
 * is a pattern, three is a coincidence.
 */
export function robotRegularity(
  people: readonly ClockInTimes[],
  thresholds: { standardDeviationMinutes: number; workingDays: number },
  now: Date,
  windowFrom: Date,
): Finding[] {
  return people
    .filter((person) => person.minutesOfDay.length >= thresholds.workingDays)
    .map((person) => ({ person, clock: aroundTheClock(person.minutesOfDay) }))
    .filter(({ clock }) => clock.spread < thresholds.standardDeviationMinutes)
    .map(({ person, clock }) => ({
      ruleCode: 'R8' as const,
      dedupeKey: `R8:${person.employeeId}:${isoMonth(now)}`,
      employeeId: person.employeeId,
      siteId: person.siteId,
      windowFrom,
      windowTo: now,
      evidence: {
        days: person.minutesOfDay.length,
        spreadMinutes: Math.round(clock.spread * 10) / 10,
        // The clock face, so a reader sees the pattern rather than the
        // statistic: "always 05:59" explains itself.
        usualTime: clockFace(clock.middle),
      },
    }));
}

// --- R9 · Device anomaly -----------------------------------------------------

export interface DeviceActivity {
  deviceId: string;
  deviceName: string;
  siteId?: string;
  /** Punches per day over the window, most recent last. */
  dailyCounts: number[];
  /** How far the device's own clock is off, in seconds. */
  clockDriftSeconds: number | null;
}

/**
 * A terminal behaving unlike itself.
 *
 * Two different smells. A **volume spike** — a device that has quietly sent
 * forty punches a day suddenly sending two hundred — is what a replayed or
 * manufactured batch looks like. A **drifting clock** matters because every
 * punch carries the device's own time: a terminal running ten minutes fast
 * can make a late arrival look punctual, every single day, with nobody
 * touching a record.
 *
 * The comparison is against the device's **own** history, not against other
 * devices: a busy gate is not an anomaly, and a quiet one is not innocent.
 */
export function deviceAnomaly(
  devices: readonly DeviceActivity[],
  thresholds: { volumeMultiple: number; medianDays: number; clockDriftMinutes: number },
  now: Date,
  windowFrom: Date,
): Finding[] {
  const findings: Finding[] = [];
  // A device needs a history to be unlike itself. A quarter of the window
  // asked for, so tuning the window tunes this too, and never fewer than a
  // week: a site that opened on Monday is not an anomaly on Friday.
  const enoughHistory = Math.max(7, Math.floor(thresholds.medianDays / 4));
  for (const device of devices) {
    const today = device.dailyCounts.at(-1) ?? 0;
    const earlier = device.dailyCounts.slice(0, -1);
    const usual = median(earlier);
    if (earlier.length >= enoughHistory && usual > 0 && today > usual * thresholds.volumeMultiple) {
      findings.push({
        ruleCode: 'R9',
        dedupeKey: `R9:volume:${device.deviceId}:${isoDate(now)}`,
        deviceId: device.deviceId,
        siteId: device.siteId,
        windowFrom,
        windowTo: now,
        evidence: {
          punchesThatDay: today,
          medianPunches: usual,
          multiple: Math.round((today / usual) * 10) / 10,
          device: device.deviceName,
        },
      });
    }
    const driftMinutes = Math.abs(device.clockDriftSeconds ?? 0) / 60;
    if (driftMinutes > thresholds.clockDriftMinutes) {
      findings.push({
        ruleCode: 'R9',
        // A drifting clock is one standing fact about a device, not
        // something that happens afresh each day. Keyed per month, it is
        // raised once and raised again if it is still wrong next month —
        // rather than every time somebody presses the sweep button.
        dedupeKey: `R9:clock:${device.deviceId}:${isoMonth(now)}`,
        deviceId: device.deviceId,
        siteId: device.siteId,
        windowFrom: now,
        windowTo: now,
        evidence: {
          clockDriftMinutes: Math.round(driftMinutes * 10) / 10,
          fast: (device.clockDriftSeconds ?? 0) > 0,
          device: device.deviceName,
        },
      });
    }
  }
  return findings;
}

// --- R3 · Paid without presence -----------------------------------------------

/** One payslip line, beside the shifts the attendance tables hold for it. */
export interface PaidPeriod {
  lineId: string;
  runId: string;
  employeeId: string;
  /** The period, as `YYYY-MM`, for a reader. */
  period: string;
  periodStartsOn: Date;
  periodEndsOn: Date;
  /** What the line paid for: its regular minutes plus its overtime minutes. */
  paidMinutes: number;
  /** Confirmed shifts inside the period, **counted again** at sweep time. */
  presentMinutes: number;
  /** Of those, the minutes a person typed in. */
  manualMinutes: number;
  /** Of those, the minutes a co-sign or a staff number made. */
  fallbackMinutes: number;
}

/**
 * A payslip paying for more hours than the shifts behind it support.
 *
 * The line's own `punchedMinutes` is deliberately **not** what it is compared
 * against — that number was copied onto the line by the same run that paid
 * it, so comparing a line with itself would prove nothing. The present
 * minutes here are counted afresh from the attendance tables, which is what
 * lets the rule see a line that was edited, a shift that was voided after the
 * money went out, or a run built on segments that have been disputed since.
 *
 * Every `CONFIRMED` segment counts, whatever its basis, or the rule would
 * fire on every honest correction an ADMIN made through the exception queue
 * (docs/plan/08 §3). The split is carried in the evidence instead, so a
 * checker sees at a glance whether the hours rest on a face or on somebody's
 * word.
 */
export function paidWithoutPresence(
  lines: readonly PaidPeriod[],
  thresholds: { toleranceMinutes: number },
  _now: Date,
): Finding[] {
  return lines
    .map((line) => ({
      line,
      beyond: paidBeyondPresence(
        line.paidMinutes,
        line.presentMinutes,
        thresholds.toleranceMinutes,
      ),
    }))
    .filter(({ beyond }) => beyond > 0)
    .map(({ line, beyond }) => ({
      ruleCode: 'R3' as const,
      // One per line, ever. A line freezes when its run is submitted, so
      // asking again next week cannot give a different answer.
      dedupeKey: `R3:${line.lineId}`,
      employeeId: line.employeeId,
      windowFrom: line.periodStartsOn,
      windowTo: line.periodEndsOn,
      evidence: {
        period: line.period,
        runId: line.runId,
        lineId: line.lineId,
        paidMinutes: line.paidMinutes,
        presentMinutes: line.presentMinutes,
        beyondToleranceMinutes: beyond,
        manualMinutes: line.manualMinutes,
        fallbackMinutes: line.fallbackMinutes,
      },
    }));
}

// --- R6 · Terminated but active -----------------------------------------------

/** Somebody who has left, and whatever has happened on their record since. */
export interface AfterLeaving {
  employeeId: string;
  siteId?: string;
  /** The last day they were employed. */
  leftOn: Date;
  /** Punches the server received after that day ended. */
  punchesAfter: number;
  /** The last of them, as `YYYY-MM-DD`. */
  lastPunchOn?: string;
  /** Every settled payslip they have, whenever its period was. The rule decides which count. */
  paidPeriods: readonly { period: string; startsOn: Date }[];
}

/**
 * A worker who has left and whose record is still moving.
 *
 * There is no threshold and no tolerance: one punch, or one payslip, for
 * somebody who is no longer employed is the whole finding. It is the plainest
 * of the eleven, and the one a defence audience understands with no
 * explanation at all.
 *
 * A period that **contains** the leaving day is not counted. Somebody who
 * left on the 12th is paid for the first twelve days of that month and that
 * payslip is correct; only a period beginning after they had gone is a
 * question.
 */
export function terminatedButActive(
  people: readonly AfterLeaving[],
  _thresholds: Record<string, number>,
  now: Date,
): Finding[] {
  return people
    .map((person) => ({
      person,
      // Only a period that **begins** after the leaving day. The month
      // somebody left in pays them for the days they worked in it, and that
      // payslip is right — so `>`, and against the period's first day, not
      // its last.
      paidAfter: [
        ...new Set(
          person.paidPeriods
            .filter((paid) => paid.startsOn.getTime() > person.leftOn.getTime())
            .map((paid) => paid.period),
        ),
      ].sort(),
    }))
    .filter(({ person, paidAfter }) => person.punchesAfter > 0 || paidAfter.length > 0)
    .map(({ person, paidAfter }) => ({
      ruleCode: 'R6' as const,
      // Keyed by the month it is noticed. The first alert is the question; if
      // it is still happening next month that is a second question, not the
      // same one left unanswered.
      dedupeKey: `R6:${person.employeeId}:${isoMonth(now)}`,
      employeeId: person.employeeId,
      siteId: person.siteId,
      windowFrom: person.leftOn,
      windowTo: now,
      evidence: {
        leftOn: isoDate(person.leftOn),
        punchesAfter: person.punchesAfter,
        ...(person.lastPunchOn === undefined ? {} : { lastPunchOn: person.lastPunchOn }),
        paidPeriodsAfter: paidAfter,
      },
    }));
}

/**
 * How tightly a set of clock times sit together, and where their middle is.
 *
 * **A clock is a circle.** 23:58 and 00:02 are four minutes apart, not
 * twenty-three hours and fifty-six — and a guard on nights is exactly the
 * person this rule is about, so treating the times as points on a line would
 * miss the manufactured logs it exists to catch and would never have looked
 * wrong.
 *
 * Each time becomes an angle round the twenty-four hours; the middle is the
 * direction they point on average, and the spread is how far they wander
 * from it. The spread is the population one (divided by how many there are,
 * not one fewer), which is the stricter reading of the threshold and the one
 * the report's tuning table is built on.
 */
function aroundTheClock(minutes: readonly number[]): { middle: number; spread: number } {
  if (minutes.length < 2) {
    return { middle: minutes[0] ?? 0, spread: Number.POSITIVE_INFINITY };
  }
  const MINUTES_IN_A_DAY = 24 * 60;
  const toAngle = (minute: number) => (minute / MINUTES_IN_A_DAY) * 2 * Math.PI;
  const eastward = average(minutes.map((minute) => Math.cos(toAngle(minute))));
  const northward = average(minutes.map((minute) => Math.sin(toAngle(minute))));
  const middleAngle = Math.atan2(northward, eastward);
  const middle =
    ((middleAngle / (2 * Math.PI)) * MINUTES_IN_A_DAY + MINUTES_IN_A_DAY) % MINUTES_IN_A_DAY;
  const spread = Math.sqrt(average(minutes.map((minute) => shortestWayRound(minute, middle) ** 2)));
  return { middle, spread };
}

/** The smaller of the two ways round the clock between two times, in minutes. */
function shortestWayRound(one: number, other: number): number {
  const MINUTES_IN_A_DAY = 24 * 60;
  const apart = Math.abs(one - other) % MINUTES_IN_A_DAY;
  return Math.min(apart, MINUTES_IN_A_DAY - apart);
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** The middle value, which one wild day cannot drag about the way an average can. */
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Minutes past midnight as a clock face: 359 becomes "05:59". */
function clockFace(minutes: number): string {
  const whole = Math.round(minutes);
  const hour = Math.floor(whole / 60) % 24;
  return `${String(hour).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
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
