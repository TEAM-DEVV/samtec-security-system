import type {
  BiometricCollision,
  BiometricCollisionList,
  BiometricConsentText,
  BiometricReasonRequest,
  ClockInAttemptList,
  CurrentUser,
  EmployeeBiometrics,
  PunchFeedList,
  RequestExemptionRequest,
  ResolveCollisionRequest,
  ReviewExemptionRequest,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import {
  CONSENT_SHA256,
  CONSENT_TEXT,
  CONSENT_VERSION,
  mockAttempts,
  mockBiometrics,
  mockCollisions,
  mockPunches,
} from '../data/biometrics';
import { mockEmployees } from '../data/employees';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  conflict,
  forbidden,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { canSeeSite } from '../scope';
import { userForRequest } from './auth';

/**
 * The mock Biometrics API and the live punch board, with the real API's
 * rules: statuses only (never an image, template or score, except the
 * collision similarity that ADMINs review), ADMIN-only changes, and two
 * people for every decision that lets a worker in without a clean face check:
 * the ADMIN who did an enrollment never decides its collision, and the ADMIN
 * who asked for an exemption never approves it.
 *
 * This mock keeps biometric statuses only. The real API also moves the
 * employee between PENDING_ENROLLMENT and ACTIVE; reload the employee to see it.
 * Tests call `resetMockBiometrics()` to start fresh.
 */
function freshCopies() {
  return {
    biometrics: mockBiometrics.map((row) => structuredClone(row)),
    collisions: mockCollisions.map((row) => structuredClone(row)),
  };
}

let { biometrics, collisions } = freshCopies();

export function resetMockBiometrics(): void {
  ({ biometrics, collisions } = freshCopies());
}

/** Switching a kiosk's fingerprints off revokes every key saved on it (the devices mock calls this). */
export function revokeMockPasskeysOn(deviceId: string): void {
  const now = new Date().toISOString();
  for (const record of biometrics) {
    record.passkeys = record.passkeys.map((key) =>
      key.deviceId === deviceId ? { ...key, revokedAt: key.revokedAt ?? now } : key,
    );
  }
}

const COLLISION_STATUSES = ['OPEN', 'RESOLVED', 'VOID'] as const;
const VERDICTS = ['DIFFERENT_PEOPLE', 'SAME_PERSON'] as const;
const EXEMPTION_REASONS = ['DECLINED', 'CANNOT_ENROLL'] as const;
const EXEMPTION_DECISIONS = ['APPROVE', 'REJECT'] as const;
const ATTEMPT_OUTCOMES = [
  'MATCHED',
  'AMBIGUOUS',
  'NOT_RECOGNISED',
  'LOW_LIVENESS',
  'FINGERPRINT_REQUESTED',
  'NOT_ME',
] as const;

type Role = CurrentUser['role'];

/** Signed in with one of these roles, or the matching 401/403. */
function signedInAs(request: Request, roles: Role[]) {
  const user = userForRequest(request);
  if (!user) return { refused: unauthorized('Sign in to continue.') };
  if (!roles.includes(user.role)) return { refused: forbidden() };
  return { user };
}

/** The employee's record, if this caller may see them (404 otherwise, like the real API). */
function visibleEmployee(user: CurrentUser, employeeId: string) {
  if (!isUuid(employeeId)) {
    return { problem: validationProblem('employeeId', 'Must be a valid ID.') };
  }
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);
  const record = biometrics.find((row) => row.employeeId === employeeId);
  if (!employee || !record || !canSeeSite(user, employee.currentSite?.id ?? null)) {
    return { problem: notFound('No employee exists with this ID.') };
  }
  return { employee, record };
}

/** Like the real API's strict schemas: a field the contract does not list is a 400. */
function unknownFieldProblem(body: object, fields: string[]) {
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  return unknown === undefined ? undefined : validationProblem(unknown, 'Unrecognized field.');
}

/** A required text field of 3 to 500 characters. */
function textProblem(value: unknown, path: string) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 500
    ? undefined
    : validationProblem(path, 'Explain in 3 to 500 characters.');
}

function reasonProblem(body: Partial<BiometricReasonRequest>) {
  return unknownFieldProblem(body, ['reason']) ?? textProblem(body.reason, 'reason');
}

/** Wipes the face and switches off every fingerprint key, keeping the history. */
function wipe(record: EmployeeBiometrics) {
  const now = new Date().toISOString();
  if (record.face.status !== 'NONE') {
    record.face = { ...record.face, status: 'REVOKED' };
  }
  record.passkeys = record.passkeys.map((key) => ({ ...key, revokedAt: key.revokedAt ?? now }));
}

function openCollisionOf(employeeId: string) {
  return collisions.find(
    (collision) => collision.employee.id === employeeId && collision.status === 'OPEN',
  );
}

/** A face wiped before anyone decided: the review closes, but its evidence stays for the ghost rules. */
function voidOpenCollision(employeeId: string) {
  const open = openCollisionOf(employeeId);
  if (open) open.status = 'VOID';
}

/** Supervisors see the reason code only: the note may hold sensitive details. */
function forViewer(user: CurrentUser, record: EmployeeBiometrics): EmployeeBiometrics {
  if (user.role !== 'SUPERVISOR' || !record.exemption) return record;
  return { ...record, exemption: { ...record.exemption, note: null } };
}

export const biometricHandlers = [
  http.get<PathParams, never, OrProblem<BiometricConsentText>>(
    apiUrl('/biometrics/consent-text'),
    ({ request }) => {
      if (!userForRequest(request)) return unauthorized('Sign in to continue.');
      return HttpResponse.json<BiometricConsentText>({
        version: CONSENT_VERSION,
        text: CONSENT_TEXT,
        sha256: CONSENT_SHA256,
      });
    },
  ),

  http.get<{ employeeId: string }, never, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometrics'),
    ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      return found.record
        ? HttpResponse.json<EmployeeBiometrics>(forViewer(user, found.record))
        : found.problem;
    },
  ),

  http.post<{ employeeId: string }, BiometricReasonRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometrics/revoke'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const bad = reasonProblem(await request.json());
      if (bad) return bad;
      wipe(found.record);
      voidOpenCollision(found.employee.id);
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.post<{ employeeId: string }, RequestExemptionRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometric-exemption'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const body = await request.json();
      const bad =
        unknownFieldProblem(body, ['reason', 'note']) ??
        (isOneOf(EXEMPTION_REASONS, body.reason ?? '')
          ? undefined
          : validationProblem('reason', `Must be one of ${EXEMPTION_REASONS.join(', ')}.`)) ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      const waitingOrApproved =
        found.record.exemption !== null && found.record.exemption.status !== 'REJECTED';
      if (
        found.employee.status !== 'PENDING_ENROLLMENT' ||
        openCollisionOf(found.employee.id) ||
        waitingOrApproved
      ) {
        return conflict(
          'Only a worker waiting for enrollment, with no open review and no exemption yet, can be exempted.',
        );
      }
      // This only asks: a second ADMIN must approve it.
      found.record.exemption = {
        status: 'REQUESTED',
        reason: body.reason,
        note: body.note,
        requestedAt: new Date().toISOString(),
        requestedByUserId: user.id,
        reviewedAt: null,
        reviewedByUserId: null,
      };
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.post<{ employeeId: string }, ReviewExemptionRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometric-exemption/review'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const exemption = found.record.exemption;
      if (exemption?.status !== 'REQUESTED') {
        return conflict('There is no request waiting for a decision.');
      }
      // Maker–checker: whoever asked may never approve it themselves.
      if (exemption.requestedByUserId === user.id) return forbidden();
      const body = await request.json();
      const bad =
        unknownFieldProblem(body, ['decision', 'note']) ??
        (isOneOf(EXEMPTION_DECISIONS, body.decision ?? '')
          ? undefined
          : validationProblem('decision', `Must be one of ${EXEMPTION_DECISIONS.join(', ')}.`)) ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      found.record.exemption = {
        ...exemption,
        status: body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewedAt: new Date().toISOString(),
        reviewedByUserId: user.id,
      };
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.post<{ employeeId: string }, BiometricReasonRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometric-consents/withdraw'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const body = await request.json();
      const bad = reasonProblem(body);
      if (bad) return bad;
      if (found.record.consent.status !== 'GIVEN') {
        return conflict('There is no consent to withdraw.');
      }
      const now = new Date().toISOString();
      // An ACTIVE face already passed the duplicate check; a PENDING one never did.
      const passedCheck = found.record.face.status === 'ACTIVE';
      wipe(found.record);
      voidOpenCollision(found.employee.id);
      found.record.consent = {
        status: 'WITHDRAWN',
        textVersion: found.record.consent.textVersion,
        at: now,
      };
      // A working guard keeps working, with co-signed clock-ins. Withdrawing
      // never activates a worker who is still waiting for enrollment.
      if (passedCheck) {
        found.record.exemption = {
          status: 'APPROVED',
          reason: 'CONSENT_WITHDRAWN',
          note: body.reason,
          requestedAt: now,
          requestedByUserId: user.id,
          reviewedAt: null,
          reviewedByUserId: null,
        };
      }
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.get<PathParams, never, OrProblem<BiometricCollisionList>>(
    apiUrl('/biometric-collisions'),
    ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const status = query.get('status') ?? 'OPEN';
      if (!isOneOf(COLLISION_STATUSES, status)) {
        return validationProblem('status', `Must be one of ${COLLISION_STATUSES.join(', ')}.`);
      }
      const matches = collisions
        .filter((collision) => collision.status === status)
        .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<BiometricCollisionList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<{ credentialId: string }, ResolveCollisionRequest, OrProblem<BiometricCollision>>(
    apiUrl('/biometric-collisions/:credentialId/resolve'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      if (!isUuid(params.credentialId)) {
        return validationProblem('credentialId', 'Must be a valid ID.');
      }
      const collision = collisions.find((row) => row.credentialId === params.credentialId);
      if (!collision) return notFound('No collision exists with this ID.');
      // Maker–checker: whoever enrolled the face may never clear it themselves.
      if (collision.enrolledByUserId === user.id) return forbidden();
      if (collision.status !== 'OPEN') {
        return conflict('This collision is no longer open: it was decided, or the face was wiped.');
      }
      const body = await request.json();
      const bad =
        unknownFieldProblem(body, ['verdict', 'note', 'keepEmployeeId']) ??
        (isOneOf(VERDICTS, body.verdict ?? '')
          ? undefined
          : validationProblem('verdict', `Must be one of ${VERDICTS.join(', ')}.`)) ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      const bothRecords = [collision.employee.id, collision.lookedLike.id];
      const keep = body.keepEmployeeId;
      if (body.verdict === 'SAME_PERSON' && !(keep && bothRecords.includes(keep))) {
        return validationProblem(
          'keepEmployeeId',
          'Say which of the two records belongs to the person you checked.',
        );
      }
      if (body.verdict === 'DIFFERENT_PEOPLE' && keep !== undefined) {
        return validationProblem('keepEmployeeId', 'Only for SAME_PERSON.');
      }
      collision.status = 'RESOLVED';
      collision.resolution = {
        verdict: body.verdict,
        keptEmployeeId: keep ?? null,
        note: body.note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: user.id,
      };
      const recordOf = (employeeId: string) =>
        biometrics.find((row) => row.employeeId === employeeId);
      const clear = (record: EmployeeBiometrics | undefined) => {
        if (record) record.face = { ...record.face, status: 'ACTIVE', dedupe: 'CLEARED' };
      };
      const block = (record: EmployeeBiometrics | undefined) => {
        if (record) record.face = { ...record.face, status: 'BLOCKED' };
      };
      const newRecord = recordOf(collision.employee.id);
      if (body.verdict === 'DIFFERENT_PEOPLE' || keep === collision.employee.id) {
        clear(newRecord);
        // One person, and the new record is the real one: the old record's face goes.
        if (body.verdict === 'SAME_PERSON') block(recordOf(collision.lookedLike.id));
      } else {
        block(newRecord);
      }
      return HttpResponse.json<BiometricCollision>(collision);
    },
  ),

  http.get<PathParams, never, OrProblem<PunchFeedList>>(
    apiUrl('/attendance/punches'),
    ({ request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL', 'SUPERVISOR']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const siteId = query.get('siteId');
      if (siteId !== null && !isUuid(siteId))
        return validationProblem('siteId', 'Must be a valid ID.');
      if (
        siteId !== null &&
        !(mockSites.some((site) => site.id === siteId) && canSeeSite(user, siteId))
      ) {
        return notFound('No site exists with this ID.');
      }
      const since = query.get('since');
      if (since !== null && Number.isNaN(Date.parse(since))) {
        return validationProblem('since', 'Must be a date and time like 2026-09-22T06:00:00Z.');
      }
      const matches = mockPunches
        .filter((punch) => canSeeSite(user, punch.siteId))
        .filter((punch) => siteId === null || punch.siteId === siteId)
        .filter((punch) => since === null || Date.parse(punch.serverTime) >= Date.parse(since));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<PunchFeedList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.get<PathParams, never, OrProblem<ClockInAttemptList>>(
    apiUrl('/attendance/clock-in-attempts'),
    ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const deviceId = query.get('deviceId');
      if (deviceId !== null && !isUuid(deviceId)) {
        return validationProblem('deviceId', 'Must be a valid ID.');
      }
      const outcome = query.get('outcome');
      if (outcome !== null && !isOneOf(ATTEMPT_OUTCOMES, outcome)) {
        return validationProblem('outcome', `Must be one of ${ATTEMPT_OUTCOMES.join(', ')}.`);
      }
      const matches = mockAttempts
        .filter((attempt) => deviceId === null || attempt.deviceId === deviceId)
        .filter((attempt) => outcome === null || attempt.outcome === outcome);
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<ClockInAttemptList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),
];
