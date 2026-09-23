import type {
  DetectionAlert,
  DetectionAlertList,
  DetectionAlertStatus,
  DetectionRule,
  DetectionRuleCode,
  DetectionRuleList,
  DetectionSeverity,
  DetectionSweepResult,
  ResolveDetectionAlertRequest,
  RiskScore,
  RiskScoreList,
  UpdateDetectionRuleRequest,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { DETECTION_ALERTS, DETECTION_RULES } from '../data/detection';
import {
  apiUrl,
  conflict,
  forbidden,
  isOneOf,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { userForRequest } from './auth';

/**
 * The mock ghost-detection API (docs/plan/08-ghost-detection-engine.md), with
 * the real rules: ADMIN and HR_PAYROLL only — a supervisor never sees this
 * queue, because a supervisor is themselves a subject of rule R7 — a note
 * required on every resolution, and a rule never acting on anybody by itself.
 */

const STATUSES: readonly DetectionAlertStatus[] = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED',
  'CONFIRMED_FRAUD',
];
const SEVERITIES: readonly DetectionSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM'];
const RULE_CODES: readonly DetectionRuleCode[] = DETECTION_RULES.map((rule) => rule.code);
const CLOSING: readonly DetectionAlertStatus[] = ['RESOLVED', 'CONFIRMED_FRAUD'];
const SEVERITY_WEIGHT: Record<DetectionSeverity, number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 2 };

const memory = {
  alerts: DETECTION_ALERTS.map((alert) => ({ ...alert })),
  rules: DETECTION_RULES.map((rule) => ({ ...rule })),
};

export function resetMockDetection(): void {
  memory.alerts = DETECTION_ALERTS.map((alert) => ({ ...alert }));
  memory.rules = DETECTION_RULES.map((rule) => ({ ...rule }));
}

/** Only an ADMIN or HR_PAYROLL may look. Everyone else is told nothing at all. */
function reader(request: Request) {
  const user = userForRequest(request);
  if (!user) {
    return { problem: unauthorized('Sign in to continue.') };
  }
  if (user.role !== 'ADMIN' && user.role !== 'HR_PAYROLL') {
    return { problem: forbidden() };
  }
  return { user };
}

export const detectionHandlers = [
  http.get(apiUrl('/detection/alerts'), ({ request }) => {
    const seen = reader(request);
    if (seen.problem) {
      return seen.problem;
    }
    const query = new URL(request.url).searchParams;
    const limit = readLimit(query);
    if (limit === undefined) {
      return validationProblem('limit', 'Use a whole number between 1 and 100.');
    }
    const status = query.get('status');
    const ruleCode = query.get('ruleCode');
    const severity = query.get('severity');
    const employeeId = query.get('employeeId');
    if (status !== null && !isOneOf(STATUSES, status)) {
      return validationProblem('status', 'Not a status this queue uses.');
    }
    if (ruleCode !== null && !isOneOf(RULE_CODES, ruleCode)) {
      return validationProblem('ruleCode', 'Not a rule this engine has.');
    }
    if (severity !== null && !isOneOf(SEVERITIES, severity)) {
      return validationProblem('severity', 'Not a severity this engine uses.');
    }

    const matching = memory.alerts
      .filter((alert) => status === null || alert.status === status)
      .filter((alert) => ruleCode === null || alert.ruleCode === ruleCode)
      .filter((alert) => severity === null || alert.severity === severity)
      .filter((alert) => employeeId === null || alert.subject.employee?.id === employeeId)
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
    const page = pageOf(matching, limit, query.get('cursor'));
    if (!page) {
      return validationProblem('cursor', 'That cursor is not one we sent.');
    }
    return HttpResponse.json<OrProblem<DetectionAlertList>>(page);
  }),

  http.get<PathParams>(apiUrl('/detection/alerts/:alertId'), ({ request, params }) => {
    const seen = reader(request);
    if (seen.problem) {
      return seen.problem;
    }
    const alert = memory.alerts.find((row) => row.id === params.alertId);
    if (!alert) {
      return notFound('No alert exists with this ID.');
    }
    return HttpResponse.json<OrProblem<DetectionAlert>>(alert);
  }),

  http.post<PathParams, ResolveDetectionAlertRequest>(
    apiUrl('/detection/alerts/:alertId/resolve'),
    async ({ request, params }) => {
      const seen = reader(request);
      if (seen.problem) {
        return seen.problem;
      }
      const alert = memory.alerts.find((row) => row.id === params.alertId);
      if (!alert) {
        return notFound('No alert exists with this ID.');
      }
      const body = await request.json();
      if (!isOneOf(CLOSING, body.status)) {
        return validationProblem('status', 'Close an alert as RESOLVED or CONFIRMED_FRAUD.');
      }
      const note = body.note?.trim() ?? '';
      if (note.length < 3) {
        // A rule never decides anything: the note is the person's reasoning,
        // and it is what the audit log keeps.
        return validationProblem('note', 'Say why, in a few words.');
      }
      if (alert.resolution) {
        return conflict('This alert was already resolved.');
      }
      alert.status = body.status;
      alert.resolution = {
        decidedByUserId: seen.user.id,
        decidedAt: new Date().toISOString(),
        note,
      };
      return HttpResponse.json<OrProblem<DetectionAlert>>(alert);
    },
  ),

  http.post(apiUrl('/detection/sweep'), ({ request }) => {
    const user = userForRequest(request);
    if (!user) {
      return unauthorized('Sign in to continue.');
    }
    if (user.role !== 'ADMIN') {
      return forbidden();
    }
    // Repeating a sweep changes nothing: every finding here is already
    // raised, and one a person resolved is never reopened.
    const enabled = memory.rules.filter((rule) => rule.enabled).map((rule) => rule.code);
    return HttpResponse.json<OrProblem<DetectionSweepResult>>({
      ranAt: new Date().toISOString(),
      raised: 0,
      rulesRun: enabled,
      rulesSkipped: memory.rules.filter((rule) => !rule.enabled).map((rule) => rule.code),
    });
  }),

  http.get(apiUrl('/detection/rules'), ({ request }) => {
    const seen = reader(request);
    if (seen.problem) {
      return seen.problem;
    }
    return HttpResponse.json<OrProblem<DetectionRuleList>>({ items: memory.rules });
  }),

  http.patch<PathParams, UpdateDetectionRuleRequest>(
    apiUrl('/detection/rules/:ruleCode'),
    async ({ request, params }) => {
      const user = userForRequest(request);
      if (!user) {
        return unauthorized('Sign in to continue.');
      }
      if (user.role !== 'ADMIN') {
        return forbidden();
      }
      const rule = memory.rules.find((row) => row.code === params.ruleCode);
      if (!rule) {
        return notFound('No rule exists with this code.');
      }
      const body = await request.json();
      if (body.enabled === undefined && body.thresholds === undefined) {
        return validationProblem('enabled', 'Send at least one field to change.');
      }
      if (body.thresholds) {
        const unknown = Object.keys(body.thresholds).filter(
          (name) => !Object.hasOwn(rule.thresholds, name),
        );
        if (unknown.length > 0) {
          return validationProblem('thresholds', `This rule has no ${unknown[0]} threshold.`);
        }
        rule.thresholds = { ...body.thresholds };
      }
      if (body.enabled !== undefined) {
        rule.enabled = body.enabled;
      }
      rule.updatedAt = new Date().toISOString();
      return HttpResponse.json<OrProblem<DetectionRule>>(rule);
    },
  ),

  http.get(apiUrl('/detection/risk-scores'), ({ request }) => {
    const seen = reader(request);
    if (seen.problem) {
      return seen.problem;
    }
    const limit = readLimit(new URL(request.url).searchParams);
    if (limit === undefined) {
      return validationProblem('limit', 'Use a whole number between 1 and 100.');
    }
    // Worked out when you ask, exactly as the real one is, so it can never
    // be stale: severity times how often that rule fired for that person.
    const byEmployee = new Map<string, RiskScore>();
    for (const alert of memory.alerts) {
      const person = alert.subject.employee;
      if (!person || alert.resolution) {
        continue;
      }
      const running = byEmployee.get(person.id);
      const weight = SEVERITY_WEIGHT[alert.severity];
      if (running) {
        running.score += weight;
        running.openAlerts += 1;
        if (weight > SEVERITY_WEIGHT[ruleSeverity(running.topRule)]) {
          running.topRule = alert.ruleCode;
        }
        continue;
      }
      byEmployee.set(person.id, {
        employee: person,
        score: weight,
        openAlerts: 1,
        topRule: alert.ruleCode,
      });
    }
    const items = [...byEmployee.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return HttpResponse.json<OrProblem<RiskScoreList>>({ items });
  }),
];

function ruleSeverity(code: DetectionRuleCode): DetectionSeverity {
  return DETECTION_RULES.find((rule) => rule.code === code)?.severity ?? 'MEDIUM';
}
