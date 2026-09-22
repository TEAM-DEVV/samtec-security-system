import type {
  BiometricCollision,
  BiometricCollisionList,
  BiometricConsentText,
  BiometricReasonRequest,
  ClockInAttemptList,
  CurrentUser,
  EmployeeBiometrics,
  PunchFeedList,
  ResolveCollisionRequest,
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
 * collision similarity that ADMINs review), ADMIN-only changes, and a
 * collision can never be decided by the ADMIN who did the enrollment.
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

const COLLISION_STATUSES = ['OPEN', 'RESOLVED'] as const;
const VERDICTS = ['DIFFERENT_PEOPLE', 'SAME_PERSON'] as const;
const ATTEMPT_OUTCOMES = [
  'MATCHED',
  'AMBIGUOUS',
  'NOT_RECOGNISED',
  'LOW_LIVENESS',
  'FINGERPRINT_REQUESTED',
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

function reasonProblem(body: Partial<BiometricReasonRequest>) {
  return typeof body.reason === 'string' && body.reason.length >= 3 && body.reason.length <= 500
    ? undefined
    : validationProblem('reason', 'Explain why in 3 to 500 characters.');
}

/** Wipes the face and switches off every fingerprint key, keeping the history. */
function wipe(record: EmployeeBiometrics) {
  const now = new Date().toISOString();
  if (record.face.status !== 'NONE') {
    record.face = { ...record.face, status: 'REVOKED' };
  }
  record.passkeys = record.passkeys.map((key) => ({ ...key, revokedAt: key.revokedAt ?? now }));
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
      return found.record ? HttpResponse.json<EmployeeBiometrics>(found.record) : found.problem;
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
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.post<{ employeeId: string }, BiometricReasonRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometric-exemption'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const body = await request.json();
      const bad = reasonProblem(body);
      if (bad) return bad;
      if (found.employee.status === 'TERMINATED' || found.record.exemption !== null) {
        return conflict('This employee is terminated or already exempt.');
      }
      found.record.exemption = { exemptAt: new Date().toISOString(), reason: body.reason };
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
      wipe(found.record);
      found.record.consent = {
        status: 'WITHDRAWN',
        textVersion: found.record.consent.textVersion,
        at: now,
      };
      // Withdrawing ends in an exemption, so the worker can keep working.
      found.record.exemption ??= { exemptAt: now, reason: body.reason };
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
      if (collision.status !== 'OPEN') return conflict('This collision has already been decided.');
      const body = await request.json();
      if (!isOneOf(VERDICTS, body.verdict ?? '')) {
        return validationProblem('verdict', `Must be one of ${VERDICTS.join(', ')}.`);
      }
      if (typeof body.note !== 'string' || body.note.length < 3 || body.note.length > 500) {
        return validationProblem('note', 'Explain the decision in 3 to 500 characters.');
      }
      collision.status = 'RESOLVED';
      collision.resolution = {
        verdict: body.verdict,
        note: body.note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: user.id,
      };
      const record = biometrics.find((row) => row.employeeId === collision.employee.id);
      if (record) {
        record.face =
          body.verdict === 'DIFFERENT_PEOPLE'
            ? { ...record.face, status: 'ACTIVE', dedupe: 'CLEARED' }
            : { ...record.face, status: 'BLOCKED' };
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
