import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  DetectionAlert as ApiAlert,
  DetectionRule as ApiRule,
  DailySweepResult,
  DetectionAlertList,
  DetectionRuleList,
  DetectionSweepResult,
  RiskScoreList,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { DEFAULT_PRESENCE_TOLERANCE_MINUTES } from '../../common/paid-beyond-presence.js';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DetectionRuleCode, DetectionSeverity } from '../../generated/prisma/enums.js';
import { AttendanceFactsService } from '../attendance/attendance-facts.service.js';
import { AccountFactsService } from '../identity/account-facts.service.js';
import { AuditService } from '../identity/audit.service.js';
import { deriveKey } from '../identity/secret-box.js';
import { type PaidLine, PayrollFactsService } from '../payroll/payroll-facts.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type {
  ListAlertsQuery,
  ResolveAlertBody,
  UpdateDetectionRuleBody,
} from './detection.schemas.js';
import {
  bilocation,
  conflictedDecision,
  deviceAnomaly,
  duplicateEnrollment,
  type Finding,
  fallbackAbuse,
  identityCollision,
  neverSeen,
  orphanPunches,
  paidWithoutPresence,
  RECURRENCE_CAP,
  RULE_CATALOGUE,
  robotRegularity,
  SEVERITY_WEIGHT,
  terminatedButActive,
} from './detection-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daily run (docs/plan/08 §7). A company is due once its last sweep is
 * this old. Twenty hours, not twenty-four, so a schedule that fires a little
 * early one day never skips the company until tomorrow.
 */
const DAILY_SWEEP_GAP_MS = 20 * 60 * 60 * 1000;

/** The most companies one daily call looks at, oldest sweep first. */
const DAILY_SWEEP_COMPANIES = 25;

/**
 * When one call stops starting new companies. The API's functions may run for
 * thirty seconds (`apps/api/vercel.json`); stopping at twenty leaves the last
 * company room to finish, and whoever is left waits for the next call.
 */
const DAILY_SWEEP_BUDGET_MS = 20_000;

/**
 * How long this instance remembers that nothing was due, so a flood of calls
 * to the public daily route costs one query a minute rather than one each.
 * The same idea as the health check's reuse window, for the same reason.
 */
const NOTHING_DUE_MS = 60_000;

/** How far back a risk score looks (docs/plan/08 §8). */
const SCORE_WINDOW_DAYS = 90;

/** The most open alerts one score is worked out from, so a read is bounded. */
const SCORE_ALERTS_READ = 2_000;

/**
 * How far back rule R6 looks for somebody who has left. Two years, the same
 * distance the payroll side of the rule reads (`PERIODS_READ` is twenty-four
 * months), so the two halves of one rule never disagree about who is in
 * scope — and so a company that has been running for a decade does not
 * re-read every leaver it ever had on every sweep.
 */
const LEAVER_WINDOW_DAYS = 2 * 365;

/**
 * What one sweep has already read, so two rules needing the same rows ask
 * for them once. R3 and R6 both read every settled payslip line.
 */
interface SweepReads {
  paidLines?: Promise<PaidLine[]>;
}

/**
 * Ghost detection (docs/plan/08-ghost-detection-engine.md).
 *
 * The rules themselves are pure functions in `detection-rules.ts`. This
 * service is only the plumbing around them: it fetches what each rule needs
 * **through the other modules' own services**, runs the rules, and writes
 * what they found.
 *
 * Imports point one way: detection reads attendance and workforce, and
 * nothing imports detection. That is why rule R3 — which blocks a payroll
 * submission — is enforced inside payroll from its own data instead of by a
 * call back into here (docs/plan/08 §1).
 *
 * Nothing here ever acts on a person. A rule raises a question; an ADMIN or
 * HR answers it, in writing.
 */
@Injectable()
export class DetectionService {
  private readonly logger = new Logger('Detection');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly attendance: AttendanceFactsService,
    private readonly accounts: AccountFactsService,
    private readonly payroll: PayrollFactsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Run every rule that is built and switched on.
   *
   * Repeating it changes nothing: each finding carries a key built from its
   * rule, its subject and its window, and a unique index means a finding
   * already raised is not raised twice — and one a person resolved is never
   * reopened.
   *
   * A rule that throws is logged by its code and skipped. One broken rule
   * must never stop the other ten.
   */
  async sweep(viewer: SignedInUser, now = new Date()): Promise<DetectionSweepResult> {
    return this.sweepCompany(viewer.companyId, viewer.userId, now);
  }

  /**
   * The daily run, called by the hosting platform's schedule with nobody
   * signed in (docs/plan/08 §7).
   *
   * **It needs no secret, on purpose.** Whoever calls it can cause at most
   * what the schedule causes — one sweep per company per twenty hours — and a
   * sweep only raises questions for a person to answer. Each company is
   * **claimed** before it is swept, by moving its `swept_at` only if it still
   * holds the value just read, so two calls arriving together never sweep one
   * company twice. The answer is a count and names nobody.
   *
   * A flood of calls costs one indexed query a minute per instance, because
   * an answer of "nothing is due" is kept for that long. The work a caller
   * can cause is bounded by the twenty-hour gap however often they ask
   * (docs/plan/08 §7).
   */
  async dailySweep(now = new Date()): Promise<DailySweepResult> {
    const startedAt = Date.now();
    if (startedAt < this.nothingDueUntil) {
      // Somebody asked a moment ago and nothing was due. Anyone may call this
      // route, so the cheap answer is worth keeping for a minute.
      return { companiesSwept: 0 };
    }
    const dueBefore = new Date(now.getTime() - DAILY_SWEEP_GAP_MS);
    const due = await this.prisma.detectionCheck.findMany({
      where: { sweptAt: { lt: dueBefore } },
      orderBy: { sweptAt: 'asc' },
      take: DAILY_SWEEP_COMPANIES,
      select: { companyId: true, sweptAt: true },
    });
    // A company with no bookmark yet gets one dated now, so its first sweep is
    // the next daily run. Starting it in the past instead would sweep every
    // company the moment it is created, which is work about no data at all.
    await this.bookmarkNewCompanies(now);
    if (due.length === 0) {
      this.nothingDueUntil = Date.now() + NOTHING_DUE_MS;
      return { companiesSwept: 0 };
    }

    let companiesSwept = 0;
    for (const company of due) {
      if (Date.now() - startedAt > DAILY_SWEEP_BUDGET_MS) {
        break;
      }
      const claimed = await this.prisma.detectionCheck.updateMany({
        where: { companyId: company.companyId, sweptAt: company.sweptAt },
        data: { sweptAt: now },
      });
      if (claimed.count === 0) {
        // Another call got here first.
        continue;
      }
      try {
        await this.sweepCompany(company.companyId, null, now);
        companiesSwept += 1;
      } catch (error) {
        // **One company's failure never becomes a silent skip.** The claim
        // already moved the bookmark, so without putting it back this company
        // would read as swept and wait a whole day; and without catching,
        // every company queued behind it would be dropped too.
        await this.prisma.detectionCheck
          .updateMany({
            where: { companyId: company.companyId, sweptAt: now },
            data: { sweptAt: company.sweptAt },
          })
          .catch(() => undefined);
        this.logger.error({
          reason: 'daily_sweep_failed',
          companyId: company.companyId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return { companiesSwept };
  }

  /** How long this instance may answer "nothing due" without asking again. */
  private nothingDueUntil = 0;

  /**
   * Gives every company without a bookmark one dated now. Bounded like the
   * sweep itself: a company that misses this call gets its bookmark on the
   * next one.
   */
  private async bookmarkNewCompanies(now: Date): Promise<void> {
    const newCompanies = await this.prisma.company.findMany({
      where: { detectionCheck: null },
      select: { id: true },
      take: DAILY_SWEEP_COMPANIES,
    });
    if (newCompanies.length === 0) {
      return;
    }
    await this.prisma.detectionCheck.createMany({
      data: newCompanies.map((company) => ({ companyId: company.id, sweptAt: now })),
      skipDuplicates: true,
    });
  }

  /**
   * One company's sweep. `actorUserId` is the ADMIN who pressed the button,
   * or null for the daily run, which the audit log then records as the system.
   */
  private async sweepCompany(
    companyId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<DetectionSweepResult> {
    const rules = await this.liveRules(companyId);
    const ran: DetectionRuleCode[] = [];
    const skipped: DetectionRuleCode[] = [];
    const reads: SweepReads = {};
    let raised = 0;

    for (const rule of RULE_CATALOGUE) {
      const row = rules.get(rule.code);
      if (!rule.built || !row?.enabled) {
        skipped.push(rule.code);
        continue;
      }
      try {
        const found = await this.runOne(
          companyId,
          rule.code,
          thresholdsOf(row) ?? rule.thresholds,
          now,
          reads,
        );
        raised += await this.record(companyId, found, rule.code, now);
        ran.push(rule.code);
      } catch (error) {
        // By code and message only: a rule's failure must never put a
        // worker's details in a log.
        this.logger.error({
          reason: 'rule_failed',
          ruleCode: rule.code,
          companyId: companyId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        skipped.push(rule.code);
      }
    }

    await this.prisma.detectionCheck.upsert({
      where: { companyId: companyId },
      create: { companyId: companyId, sweptAt: now },
      update: { sweptAt: now },
    });
    await this.audit.record({
      companyId: companyId,
      actorUserId,
      action: 'detection.swept',
      entityType: 'company',
      entityId: companyId,
      detail: { raised, rulesRun: ran.join(','), rulesSkipped: skipped.join(',') },
    });
    return { ranAt: now.toISOString(), raised, rulesRun: ran, rulesSkipped: skipped };
  }

  /** The queue, newest first. */
  async list(viewer: SignedInUser, query: ListAlertsQuery): Promise<DetectionAlertList> {
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === undefined) {
      throw new BadRequestException({
        message: [
          {
            path: ['cursor'],
            message: 'The cursor is not valid. Start again from the first page.',
          },
        ],
      });
    }
    const rows = await this.prisma.detectionAlert.findMany({
      where: {
        companyId: viewer.companyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.ruleCode ? { ruleCode: query.ruleCode } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      include: ALERT_INCLUDE,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (row) => row.id);
    return { items: page.pageRows.map(toApiAlert), nextCursor: page.nextCursor };
  }

  async get(viewer: SignedInUser, alertId: string): Promise<ApiAlert> {
    return toApiAlert(await this.byId(viewer, alertId));
  }

  /**
   * A person closes an alert, in writing. `CONFIRMED_FRAUD` is this
   * company's record of what it found, never an action the system took
   * against anybody.
   */
  async resolve(viewer: SignedInUser, alertId: string, body: ResolveAlertBody): Promise<ApiAlert> {
    await this.byId(viewer, alertId);
    const decided = await this.prisma.$transaction(async (tx) => {
      // Two people may be looking at the same queue. The condition that
      // decides rides on the update itself, so the second one matches
      // nothing and is told plainly, rather than meeting the database's
      // "never decided again" trigger.
      const closed = await tx.detectionAlert.updateMany({
        where: { id: alertId, companyId: viewer.companyId, resolvedAt: null },
        data: {
          status: body.status,
          resolvedByUserId: viewer.userId,
          resolvedAt: new Date(),
          resolutionNote: body.note,
        },
      });
      if (closed.count !== 1) {
        throw new ConflictException('This alert was already resolved.');
      }
      const updated = await tx.detectionAlert.findFirstOrThrow({
        where: { id: alertId },
        include: ALERT_INCLUDE,
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'detection.alert_resolved',
          entityType: 'detection_alert',
          entityId: alertId,
          detail: { ruleCode: updated.ruleCode, status: body.status },
        },
        tx,
      );
      return updated;
    });
    return toApiAlert(decided);
  }

  /** Every rule and the numbers it is using right now. */
  async rules(viewer: SignedInUser): Promise<DetectionRuleList> {
    const live = await this.liveRules(viewer.companyId);
    return {
      items: RULE_CATALOGUE.map((rule) => {
        const row = live.get(rule.code);
        return {
          code: rule.code,
          name: rule.name,
          description: rule.built ? rule.description : `${rule.description} (not built yet)`,
          severity: row?.severity ?? rule.severity,
          enabled: (row?.enabled ?? true) && rule.built,
          thresholds: thresholdsOf(row) ?? rule.thresholds,
          updatedAt: (row?.updatedAt ?? row?.createdAt ?? new Date()).toISOString(),
        } satisfies ApiRule;
      }),
    };
  }

  /** Switch a rule off, or move a threshold. ADMIN only, and audited. */
  async updateRule(
    viewer: SignedInUser,
    code: DetectionRuleCode,
    body: UpdateDetectionRuleBody,
  ): Promise<ApiRule> {
    const known = RULE_CATALOGUE.find((rule) => rule.code === code);
    if (!known) {
      throw new NotFoundException('No rule exists with this code.');
    }
    const live = await this.liveRules(viewer.companyId);
    const row = live.get(code);
    const current = thresholdsOf(row) ?? known.thresholds;
    if (body.thresholds) {
      const unknown = Object.keys(body.thresholds).filter((name) => !Object.hasOwn(current, name));
      if (unknown.length > 0) {
        throw new ConflictException(`This rule has no ${unknown[0]} threshold.`);
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.detectionRule.update({
        where: { companyId_code: { companyId: viewer.companyId, code } },
        data: {
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.thresholds ? { thresholds: body.thresholds as Prisma.InputJsonValue } : {}),
          updatedByUserId: viewer.userId,
        },
      });
      await this.audit.record(
        {
          companyId: viewer.companyId,
          actorUserId: viewer.userId,
          action: 'detection.rule_changed',
          entityType: 'detection_rule',
          entityId: saved.id,
          // The old and the new, so a tuning table can be rebuilt from the log.
          detail: { code, was: JSON.stringify(current), now: JSON.stringify(saved.thresholds) },
        },
        tx,
      );
      return saved;
    });
    return {
      code,
      name: known.name,
      description: known.description,
      severity: updated.severity,
      enabled: updated.enabled && known.built,
      thresholds: thresholdsOf(updated) ?? known.thresholds,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Who the open alerts point at. Worked out when asked, never stored, so it
   * can never be stale.
   */
  async riskScores(viewer: SignedInUser, limit: number): Promise<RiskScoreList> {
    const open = await this.prisma.detectionAlert.findMany({
      where: {
        companyId: viewer.companyId,
        resolvedAt: null,
        employeeId: { not: null },
        // "Times that rule fired for that worker in 90 days" (docs/plan/08
        // §8). Without the window an alert nobody triaged keeps adding to
        // somebody's score for ever.
        openedAt: { gte: new Date(Date.now() - SCORE_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: { openedAt: 'desc' },
      // One company's open alerts, capped like every other read here.
      take: SCORE_ALERTS_READ,
      select: {
        employeeId: true,
        ruleCode: true,
        severity: true,
        employee: { select: { id: true, staffNumber: true, firstName: true, lastName: true } },
      },
    });
    const byEmployee = new Map<
      string,
      {
        employee: { id: string; staffNumber: string; fullName: string };
        score: number;
        openAlerts: number;
        perRule: Map<DetectionRuleCode, { times: number; severity: DetectionSeverity }>;
      }
    >();
    for (const row of open) {
      const person = row.employee;
      if (!person) {
        continue;
      }
      const running = byEmployee.get(person.id) ?? {
        employee: {
          id: person.id,
          staffNumber: person.staffNumber,
          fullName: `${person.firstName} ${person.lastName}`,
        },
        score: 0,
        openAlerts: 0,
        perRule: new Map<DetectionRuleCode, { times: number; severity: DetectionSeverity }>(),
      };
      const seenBefore = running.perRule.get(row.ruleCode);
      running.perRule.set(row.ruleCode, {
        times: (seenBefore?.times ?? 0) + 1,
        severity: seenBefore?.severity ?? row.severity,
      });
      running.openAlerts += 1;
      byEmployee.set(person.id, running);
    }
    const items = [...byEmployee.values()]
      .map((row) => {
        let score = 0;
        let topRule: DetectionRuleCode = 'R1';
        let best = -1;
        for (const [code, seen] of row.perRule) {
          const { times, severity } = seen;
          // The severity the alert was raised with, not the rule's severity
          // today: an ADMIN may have changed the rule since, and that must
          // not silently rewrite what an old finding was worth.
          const weight = SEVERITY_WEIGHT[severity] * Math.min(times, RECURRENCE_CAP);
          score += weight;
          if (weight > best) {
            best = weight;
            topRule = code;
          }
        }
        return { employee: row.employee, score, openAlerts: row.openAlerts, topRule };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return { items };
  }

  // --- the plumbing ---------------------------------------------------------

  /** One rule's findings, with everything it needs read through its owner's service. */
  private async runOne(
    companyId: string,
    code: DetectionRuleCode,
    thresholds: Record<string, number>,
    now: Date,
    reads: SweepReads = {},
  ): Promise<Finding[]> {
    const paidLines = () => (reads.paidLines ??= this.payroll.paidLines(companyId));
    if (code === 'R5') {
      const workers = await this.employees.onTheBooks(companyId);
      const punched = await this.attendance.everPunched(
        companyId,
        workers.map((worker) => worker.id),
      );
      return neverSeen(
        workers.map((worker) => ({
          employeeId: worker.id,
          hireDate: worker.hireDate,
          siteId: worker.siteId,
          punches: punched.has(worker.id) ? 1 : 0,
        })),
        { days: thresholds.days ?? 14 },
        now,
      );
    }
    if (code === 'R4') {
      const days = thresholds.days ?? 30;
      const counts = await this.attendance.overlapsPerEmployee(
        companyId,
        new Date(now.getTime() - days * DAY_MS),
      );
      return bilocation(counts, { overlaps: thresholds.overlaps ?? 3, days }, now);
    }
    if (code === 'R1') {
      const collisions = await this.attendance.openFaceCollisions(companyId);
      return duplicateEnrollment(collisions, thresholds, now);
    }
    if (code === 'R2') {
      const shared = await this.employees.sharedPhoneNumbers(companyId);
      return identityCollision(
        shared.map((row) => ({ kind: 'phone' as const, ...row })),
        { sharedBy: thresholds.sharedBy ?? 2 },
        now,
        deriveKey(this.config.authSecret, 'detection-fingerprint'),
      );
    }
    if (code === 'R7') {
      const days = thresholds.days ?? 30;
      const from = new Date(now.getTime() - days * DAY_MS);
      const [workers, supervisors] = await Promise.all([
        this.attendance.clockInMethodsPerEmployee(companyId, from),
        this.attendance.coSignsPerSupervisor(companyId, from),
      ]);
      return fallbackAbuse(
        workers,
        supervisors,
        {
          sharePercent: thresholds.sharePercent ?? 40,
          days,
          minimumClockIns: thresholds.minimumClockIns ?? 5,
          supervisorCoSigns: thresholds.supervisorCoSigns ?? 20,
        },
        now,
      );
    }
    if (code === 'R3') {
      const lines = await paidLines();
      if (lines.length === 0) {
        return [];
      }
      // One entry per period, however many lines sit in it, so the attendance
      // module is asked once a month and not once a payslip.
      const periods = [
        ...new Map(
          lines.map((line) => [
            line.periodId,
            { periodId: line.periodId, startsOn: line.periodStartsOn, endsOn: line.periodEndsOn },
          ]),
        ).values(),
      ];
      const present = await this.attendance.presentMinutesPerPeriod(companyId, periods);
      return paidWithoutPresence(
        lines.map((line) => {
          const seen = present.get(`${line.periodId}:${line.employeeId}`);
          return {
            ...line,
            // Nothing found means nothing worked. A period with no confirmed
            // shift at all is the loudest case this rule has, not a gap to
            // pass over.
            presentMinutes: seen?.minutes ?? 0,
            manualMinutes: seen?.manualMinutes ?? 0,
            fallbackMinutes: seen?.fallbackMinutes ?? 0,
          };
        }),
        {
          toleranceMinutes: thresholds.toleranceMinutes ?? DEFAULT_PRESENCE_TOLERANCE_MINUTES,
        },
        now,
      );
    }
    if (code === 'R6') {
      const leavers = await this.employees.whoHasLeft(
        companyId,
        new Date(now.getTime() - LEAVER_WINDOW_DAYS * DAY_MS),
      );
      if (leavers.length === 0) {
        return [];
      }
      const [punches, lines] = await Promise.all([
        this.attendance.punchesAfterLeaving(companyId, leavers),
        paidLines(),
      ]);
      // Every payslip a leaver has, whenever its period was. Which of them
      // count is the rule's decision, not this plumbing's.
      const paidPeriods = new Map<string, { period: string; startsOn: Date }[]>();
      for (const line of lines) {
        paidPeriods.set(line.employeeId, [
          ...(paidPeriods.get(line.employeeId) ?? []),
          { period: line.period, startsOn: line.periodStartsOn },
        ]);
      }
      return terminatedButActive(
        leavers.map((leaver) => ({
          ...leaver,
          punchesAfter: punches.get(leaver.employeeId)?.punches ?? 0,
          lastPunchOn: punches.get(leaver.employeeId)?.lastPunchOn,
          paidPeriods: paidPeriods.get(leaver.employeeId) ?? [],
        })),
        thresholds,
        now,
      );
    }
    if (code === 'R11') {
      const { decisions, hands } = await this.attendance.twoPersonDecisions(companyId);
      // Who made each decider's own administrator account, asked of the
      // module that owns accounts (docs/plan/06, "Two administrators").
      const accountsMadeBy = await this.accounts.whoMadeTheseAdmins(
        companyId,
        decisions.map((decision) => decision.decidedByUserId),
      );
      return conflictedDecision(decisions, hands, thresholds, now, accountsMadeBy);
    }
    if (code === 'R8') {
      const days = thresholds.workingDays ?? 10;
      // Three times the days asked for, so ten working days can be found
      // inside a stretch that had weekends and rest days in it.
      const from = new Date(now.getTime() - days * 3 * DAY_MS);
      const people = await this.attendance.clockInTimesPerEmployee(companyId, from);
      return robotRegularity(
        people,
        {
          standardDeviationMinutes: thresholds.standardDeviationMinutes ?? 3,
          workingDays: days,
        },
        now,
        // The window really asked for, so an investigator is told how far
        // back the evidence comes from rather than how many days had data.
        from,
      );
    }
    if (code === 'R9') {
      const days = thresholds.medianDays ?? 30;
      const from = new Date(now.getTime() - days * DAY_MS);
      const devices = await this.attendance.deviceActivity(companyId, from, now);
      return deviceAnomaly(
        devices,
        {
          volumeMultiple: thresholds.volumeMultiple ?? 3,
          medianDays: days,
          clockDriftMinutes: thresholds.clockDriftMinutes ?? 5,
        },
        now,
        from,
      );
    }
    if (code === 'R10') {
      const days = thresholds.days ?? 7;
      const counts = await this.attendance.orphanPunchesPerDevice(
        companyId,
        new Date(now.getTime() - days * DAY_MS),
      );
      return orphanPunches(counts, { punches: thresholds.punches ?? 5, days }, now);
    }
    // Every built rule is handled above; the rest are skipped before we get here.
    return [];
  }

  /** Writes what a rule found, skipping anything already raised. */
  private async record(
    companyId: string,
    findings: readonly Finding[],
    code: DetectionRuleCode,
    now: Date,
  ): Promise<number> {
    if (findings.length === 0) {
      return 0;
    }
    const written = await this.prisma.detectionAlert.createManyAndReturn({
      data: findings.map((finding) => ({
        companyId,
        ruleCode: code,
        severity: severityOf(code),
        dedupeKey: finding.dedupeKey,
        employeeId: finding.employeeId ?? null,
        deviceId: finding.deviceId ?? null,
        siteId: finding.siteId ?? null,
        windowFrom: finding.windowFrom,
        windowTo: finding.windowTo,
        evidence: finding.evidence as Prisma.InputJsonValue,
        openedAt: now,
      })),
      // The unique key is what makes a sweep repeatable: a finding already
      // raised is skipped, and one a person resolved is never reopened.
      skipDuplicates: true,
      select: { id: true },
    });
    return written.length;
  }

  /**
   * This company's rule rows, making them on first use so a new company
   * starts with every rule on and the catalogue's own numbers.
   */
  private async liveRules(companyId: string) {
    const existing = await this.prisma.detectionRule.findMany({ where: { companyId } });
    if (existing.length < RULE_CATALOGUE.length) {
      await this.prisma.detectionRule.createMany({
        data: RULE_CATALOGUE.map((rule) => ({
          companyId,
          code: rule.code,
          severity: rule.severity,
          thresholds: rule.thresholds as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      const filled = await this.prisma.detectionRule.findMany({ where: { companyId } });
      return new Map(filled.map((row) => [row.code, row]));
    }
    return new Map(existing.map((row) => [row.code, row]));
  }

  private async byId(viewer: SignedInUser, alertId: string) {
    const alert = await this.prisma.detectionAlert.findFirst({
      where: { id: alertId, companyId: viewer.companyId },
      include: ALERT_INCLUDE,
    });
    if (!alert) {
      // A record this caller may not see answers 404, never 403.
      throw new NotFoundException('No alert exists with this ID.');
    }
    return alert;
  }
}

const ALERT_INCLUDE = {
  employee: { select: { id: true, staffNumber: true, firstName: true, lastName: true } },
  device: { select: { id: true, name: true } },
} as const;

type AlertRow = Prisma.DetectionAlertGetPayload<{ include: typeof ALERT_INCLUDE }>;

function toApiAlert(row: AlertRow): ApiAlert {
  return {
    id: row.id,
    ruleCode: row.ruleCode,
    severity: row.severity,
    status: row.status,
    subject: {
      employee: row.employee
        ? {
            id: row.employee.id,
            staffNumber: row.employee.staffNumber,
            fullName: `${row.employee.firstName} ${row.employee.lastName}`,
          }
        : null,
      device: row.device ? { id: row.device.id, name: row.device.name } : null,
      siteId: row.siteId,
    },
    windowFrom: toIsoDate(row.windowFrom),
    windowTo: toIsoDate(row.windowTo),
    evidence: row.evidence as Record<string, unknown>,
    openedAt: row.openedAt.toISOString(),
    resolution:
      row.resolvedAt && row.resolvedByUserId && row.resolutionNote
        ? {
            decidedByUserId: row.resolvedByUserId,
            decidedAt: row.resolvedAt.toISOString(),
            note: row.resolutionNote,
          }
        : null,
  };
}

function severityOf(code: DetectionRuleCode) {
  return RULE_CATALOGUE.find((rule) => rule.code === code)?.severity ?? 'MEDIUM';
}

/** A rule row's thresholds, or undefined when it has none stored. */
function thresholdsOf(row?: { thresholds: Prisma.JsonValue }): Record<string, number> | undefined {
  if (!row || typeof row.thresholds !== 'object' || row.thresholds === null) {
    return undefined;
  }
  return row.thresholds as Record<string, number>;
}
