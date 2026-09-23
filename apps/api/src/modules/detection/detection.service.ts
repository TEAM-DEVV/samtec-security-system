import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  DetectionAlert as ApiAlert,
  DetectionRule as ApiRule,
  DetectionAlertList,
  DetectionRuleList,
  DetectionSweepResult,
  RiskScoreList,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { toIsoDate } from '../../common/dates.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DetectionRuleCode } from '../../generated/prisma/enums.js';
import { AttendanceFactsService } from '../attendance/attendance-facts.service.js';
import { AuditService } from '../identity/audit.service.js';
import { EmployeesService } from '../workforce/employees.service.js';
import type {
  ListAlertsQuery,
  ResolveAlertBody,
  UpdateDetectionRuleBody,
} from './detection.schemas.js';
import {
  bilocation,
  type Finding,
  neverSeen,
  orphanPunches,
  RECURRENCE_CAP,
  RULE_CATALOGUE,
  SEVERITY_WEIGHT,
} from './detection-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const rules = await this.liveRules(viewer.companyId);
    const ran: DetectionRuleCode[] = [];
    const skipped: DetectionRuleCode[] = [];
    let raised = 0;

    for (const rule of RULE_CATALOGUE) {
      const row = rules.get(rule.code);
      if (!rule.built || !row?.enabled) {
        skipped.push(rule.code);
        continue;
      }
      try {
        const found = await this.runOne(
          viewer.companyId,
          rule.code,
          thresholdsOf(row) ?? rule.thresholds,
          now,
        );
        raised += await this.record(viewer.companyId, found, rule.code, now);
        ran.push(rule.code);
      } catch (error) {
        // By code and message only: a rule's failure must never put a
        // worker's details in a log.
        this.logger.error({
          reason: 'rule_failed',
          ruleCode: rule.code,
          companyId: viewer.companyId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        skipped.push(rule.code);
      }
    }

    await this.prisma.detectionCheck.upsert({
      where: { companyId: viewer.companyId },
      create: { companyId: viewer.companyId, sweptAt: now },
      update: { sweptAt: now },
    });
    await this.audit.record({
      companyId: viewer.companyId,
      actorUserId: viewer.userId,
      action: 'detection.swept',
      entityType: 'company',
      entityId: viewer.companyId,
      detail: { raised, rulesRun: ran.join(','), rulesSkipped: skipped.join(',') },
    });
    return { ranAt: now.toISOString(), raised, rulesRun: ran, rulesSkipped: skipped };
  }

  /** The queue, newest first. */
  async list(viewer: SignedInUser, query: ListAlertsQuery): Promise<DetectionAlertList> {
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
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
      // Read it again now: two people may be looking at the same queue.
      const current = await tx.detectionAlert.findFirstOrThrow({
        where: { id: alertId, companyId: viewer.companyId },
        select: { resolvedAt: true },
      });
      if (current.resolvedAt !== null) {
        throw new ConflictException('This alert was already resolved.');
      }
      const updated = await tx.detectionAlert.update({
        where: { id: alertId },
        data: {
          status: body.status,
          resolvedByUserId: viewer.userId,
          resolvedAt: new Date(),
          resolutionNote: body.note,
        },
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
      where: { companyId: viewer.companyId, resolvedAt: null, employeeId: { not: null } },
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
        perRule: Map<DetectionRuleCode, number>;
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
        perRule: new Map<DetectionRuleCode, number>(),
      };
      const seenBefore = running.perRule.get(row.ruleCode) ?? 0;
      running.perRule.set(row.ruleCode, seenBefore + 1);
      running.openAlerts += 1;
      byEmployee.set(person.id, running);
    }
    const items = [...byEmployee.values()]
      .map((row) => {
        let score = 0;
        let topRule: DetectionRuleCode = 'R1';
        let best = -1;
        for (const [code, times] of row.perRule) {
          const weight = SEVERITY_WEIGHT[severityOf(code)] * Math.min(times, RECURRENCE_CAP);
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
  ): Promise<Finding[]> {
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
