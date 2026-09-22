import type {
  BiometricCollision,
  BiometricCollisionList,
  BiometricConsentText,
  BiometricReasonRequest,
  ClockInAttemptList,
  CurrentUser,
  Employee,
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
 * collision similarity that ADMINs review), ADMIN-only changes, and a second
 * ADMIN for every decision that lets a worker in without a clean face check.
 * Nobody decides on their own action: the ADMIN who enrolled a face never
 * decides its collision, and whoever asked for an exemption, enrolled a face
 * for that worker, or wiped one never approves it. Anyone who revoked or
 * withdrew a face of either record never decides a collision either.
 *
 * Errors come in the real API's order (docs/plan/05-api-contract.md): sign-in
 * and role (401, 403), a bad ID or body (400), not found (404), a field that
 * is wrong for this record (400), the second-person rule (403), then a clash
 * with the current state (409).
 *
 * This mock keeps biometric statuses only: it never changes an employee's
 * status, so a screen should reload the employee from the real API rather
 * than rely on it. It knows who enrolled a face only for faces that
 * collided.
 * Tests call `resetMockBiometrics()` to start fresh.
 */
function freshCopies() {
  return {
    biometrics: mockBiometrics.map((row) => structuredClone(row)),
    collisions: mockCollisions.map((row) => structuredClone(row)),
  };
}

let { biometrics, collisions } = freshCopies();
/** Who revoked or withdrew each worker's face: they may never decide that worker's questions. */
let wipedBy = new Map<string, Set<string>>();

export function resetMockBiometrics(): void {
  ({ biometrics, collisions } = freshCopies());
  wipedBy = new Map();
}

function rememberWiper(employeeId: string, user: CurrentUser) {
  const wipers = wipedBy.get(employeeId) ?? new Set<string>();
  wipers.add(user.id);
  wipedBy.set(employeeId, wipers);
}

function wipedAFaceOf(employeeId: string, user: CurrentUser) {
  return wipedBy.get(employeeId)?.has(user.id) ?? false;
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

const COLLISION_STATUSES = ['OPEN', 'RESOLVED'] as const;
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
  'FALLBACK_REFUSED',
] as const;

type Role = CurrentUser['role'];
type Body = Record<string, unknown>;

/** Signed in with one of these roles, or the matching 401/403. */
function signedInAs(request: Request, roles: Role[]) {
  const user = userForRequest(request);
  if (!user) return { refused: unauthorized('Sign in to continue.') };
  if (!roles.includes(user.role)) return { refused: forbidden() };
  return { user };
}

function idProblem(id: string, path: string) {
  return isUuid(id) ? undefined : validationProblem(path, 'Must be a valid ID.');
}

/** Like the real API's strict schemas: a field the contract does not list is a 400. */
function unknownFieldProblem(body: Body, fields: string[]) {
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  return unknown === undefined ? undefined : validationProblem(unknown, 'Unrecognized field.');
}

/** A required text field of 3 to 500 characters. */
function textProblem(value: unknown, path: string) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 500
    ? undefined
    : validationProblem(path, 'Explain in 3 to 500 characters.');
}

function choiceProblem(choices: readonly string[], value: unknown, path: string) {
  return typeof value === 'string' && choices.includes(value)
    ? undefined
    : validationProblem(path, `Must be one of ${choices.join(', ')}.`);
}

function reasonProblem(body: Body) {
  return unknownFieldProblem(body, ['reason']) ?? textProblem(body.reason, 'reason');
}

/** The employee's record, if this caller may see them (404 otherwise, like the real API). */
function visibleEmployee(user: CurrentUser, employeeId: string) {
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);
  const record = biometrics.find((row) => row.employeeId === employeeId);
  if (!employee || !record || !canSeeSite(user, employee.currentSite?.id ?? null)) {
    return { problem: notFound('No employee exists with this ID.') };
  }
  return { employee, record };
}

function openCollisionOf(employeeId: string) {
  return collisions.find(
    (collision) => collision.employee.id === employeeId && collision.status === 'OPEN',
  );
}

/**
 * The employee's status as the real API would have it. The mock never changes
 * employee records, but a withdrawal waiting for its exemption means the real
 * API has moved the worker back to PENDING_ENROLLMENT.
 */
function statusOf(employee: Employee, record: EmployeeBiometrics) {
  const withdrawalWaiting =
    record.exemption?.reason === 'CONSENT_WITHDRAWN' && record.exemption.status === 'REQUESTED';
  return withdrawalWaiting ? 'PENDING_ENROLLMENT' : employee.status;
}

/** Only a worker waiting for enrollment, with no face and no open review, may work without biometrics. */
function mayBeExempted(employee: Employee, record: EmployeeBiometrics) {
  return (
    statusOf(employee, record) === 'PENDING_ENROLLMENT' &&
    !openCollisionOf(record.employeeId) &&
    !['PENDING', 'ACTIVE', 'BLOCKED'].includes(record.face.status)
  );
}

/** Supervisors see the reason code only: the note may hold sensitive details. */
function forViewer(user: CurrentUser, record: EmployeeBiometrics): EmployeeBiometrics {
  if (user.role !== 'SUPERVISOR' || !record.exemption) return record;
  return { ...record, exemption: { ...record.exemption, note: null } };
}

/** Wipes the face and switches off every fingerprint key, keeping the history. */
function wipe(record: EmployeeBiometrics) {
  const now = new Date().toISOString();
  // A face blocked as a duplicate is already wiped, and the block is final.
  if (record.face.status !== 'NONE' && record.face.status !== 'BLOCKED') {
    record.face = { ...record.face, status: 'REVOKED' };
  }
  record.passkeys = record.passkeys.map((key) => ({ ...key, revokedAt: key.revokedAt ?? now }));
}

/** A waiting or approved exemption no longer applies. */
function endExemption(record: EmployeeBiometrics) {
  const exemption = record.exemption;
  if (exemption?.status === 'REQUESTED' || exemption?.status === 'APPROVED') {
    record.exemption = { ...exemption, status: 'ENDED' };
  }
}

/** Whether this user enrolled a face for this worker (the mock knows it only for faces that collided). */
function enrolledAFaceFor(employeeId: string, user: CurrentUser) {
  return collisions.some(
    (collision) => collision.employee.id === employeeId && collision.enrolledByUserId === user.id,
  );
}

/** A second ADMIN cleared this face. A face wiped in the meantime stays wiped. */
function clearFace(record: EmployeeBiometrics | undefined) {
  if (!record) return;
  const usable = record.face.status === 'PENDING';
  record.face = {
    ...record.face,
    status: usable ? 'ACTIVE' : record.face.status,
    dedupe: 'CLEARED',
  };
  // A face in use ends any exemption.
  if (usable) endExemption(record);
}

/** One person, two records: the other record is wiped and blocked for good, and loses its exemption. */
function blockRecord(record: EmployeeBiometrics | undefined) {
  if (!record) return;
  wipe(record);
  record.face = { ...record.face, status: 'BLOCKED' };
  endExemption(record);
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
      const badId = idProblem(params.employeeId, 'employeeId');
      if (badId) return badId;
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
      const body: Body = await request.json();
      const bad = idProblem(params.employeeId, 'employeeId') ?? reasonProblem(body);
      if (bad) return bad;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      // A revoke can never wipe away a question that a second ADMIN must
      // answer (an open review, or an exemption request waiting), nor undo a
      // block, which is final.
      if (
        openCollisionOf(found.employee.id) ||
        found.record.exemption?.status === 'REQUESTED' ||
        found.record.face.status === 'BLOCKED'
      ) {
        return conflict(
          'This worker has an open question for a second ADMIN, or is blocked as a duplicate.',
        );
      }
      wipe(found.record);
      rememberWiper(found.employee.id, user);
      // An approved exemption ends too, so working without a face needs two ADMINs again.
      endExemption(found.record);
      return HttpResponse.json<EmployeeBiometrics>(found.record);
    },
  ),

  http.post<{ employeeId: string }, RequestExemptionRequest, OrProblem<EmployeeBiometrics>>(
    apiUrl('/employees/:employeeId/biometric-exemption'),
    async ({ params, request }) => {
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Body = await request.json();
      const bad =
        idProblem(params.employeeId, 'employeeId') ??
        unknownFieldProblem(body, ['reason', 'note']) ??
        choiceProblem(EXEMPTION_REASONS, body.reason, 'reason') ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const exemption = found.record.exemption;
      const waitingOrApproved =
        exemption?.status === 'REQUESTED' || exemption?.status === 'APPROVED';
      if (!mayBeExempted(found.employee, found.record) || waitingOrApproved) {
        return conflict(
          'Only a worker waiting for enrollment, with no face, no open question and no exemption yet, can be exempted.',
        );
      }
      // This only asks: a second ADMIN must approve it.
      found.record.exemption = {
        status: 'REQUESTED',
        reason: body.reason as RequestExemptionRequest['reason'],
        note: body.note as string,
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
      const body: Body = await request.json();
      const bad =
        idProblem(params.employeeId, 'employeeId') ??
        unknownFieldProblem(body, ['decision', 'note']) ??
        choiceProblem(EXEMPTION_DECISIONS, body.decision, 'decision') ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      const exemption = found.record.exemption;
      // Never the asker, anyone who enrolled a face for this worker, or anyone who wiped one.
      if (
        exemption?.requestedByUserId === user.id ||
        enrolledAFaceFor(found.employee.id, user) ||
        wipedAFaceOf(found.employee.id, user)
      ) {
        return forbidden();
      }
      if (exemption?.status !== 'REQUESTED') {
        return conflict('There is no request waiting for a decision.');
      }
      // Approving checks the rules again; rejecting is always possible.
      if (body.decision === 'APPROVE' && !mayBeExempted(found.employee, found.record)) {
        return conflict('This worker no longer qualifies for an exemption.');
      }
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
      // Only an ADMIN records it, so the exemption it files needs a different ADMIN.
      const { user, refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const body: Body = await request.json();
      const bad = idProblem(params.employeeId, 'employeeId') ?? reasonProblem(body);
      if (bad) return bad;
      const found = visibleEmployee(user, params.employeeId);
      if (!found.record) return found.problem;
      if (found.record.consent.status !== 'GIVEN') {
        return conflict('There is no consent to withdraw.');
      }
      const now = new Date().toISOString();
      // Only an ACTIVE face has passed the duplicate check.
      const passedCheck = found.record.face.status === 'ACTIVE';
      wipe(found.record);
      found.record.consent = {
        status: 'WITHDRAWN',
        textVersion: found.record.consent.textVersion,
        at: now,
      };
      rememberWiper(found.employee.id, user);
      // A wiped face is out of the duplicate check, so a second ADMIN must
      // vouch for the worker before they work without it: the API files the
      // request. (The real API also moves the worker back to
      // PENDING_ENROLLMENT until then.) An open review stays open, and
      // withdrawing never activates anyone.
      const alreadyExempt = found.record.exemption?.status === 'APPROVED';
      if (passedCheck && found.employee.status === 'ACTIVE' && !alreadyExempt) {
        found.record.exemption = {
          status: 'REQUESTED',
          reason: 'CONSENT_WITHDRAWN',
          note: body.reason as string,
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
      const body: Body = await request.json();
      const samePerson = body.verdict === 'SAME_PERSON';
      const bad =
        idProblem(params.credentialId, 'credentialId') ??
        choiceProblem(VERDICTS, body.verdict, 'verdict') ??
        // SAME_PERSON must name the record to keep; DIFFERENT_PEOPLE must not.
        unknownFieldProblem(
          body,
          samePerson ? ['verdict', 'keepEmployeeId', 'note'] : ['verdict', 'note'],
        ) ??
        (samePerson ? idProblem(String(body.keepEmployeeId ?? ''), 'keepEmployeeId') : undefined) ??
        textProblem(body.note, 'note');
      if (bad) return bad;
      const collision = collisions.find((row) => row.credentialId === params.credentialId);
      if (!collision) return notFound('No collision exists with this ID.');
      const keep = samePerson ? String(body.keepEmployeeId) : null;
      if (keep !== null && keep !== collision.employee.id && keep !== collision.lookedLike.id) {
        return validationProblem(
          'keepEmployeeId',
          'Must be one of the two records in this collision.',
        );
      }
      // Never the ADMIN who enrolled this face, nor anyone who wiped a face of either record.
      const conflicted =
        collision.enrolledByUserId === user.id ||
        wipedAFaceOf(collision.employee.id, user) ||
        wipedAFaceOf(collision.lookedLike.id, user);
      if (conflicted) return forbidden();
      if (collision.status !== 'OPEN') return conflict('This collision has already been decided.');

      collision.status = 'RESOLVED';
      collision.resolution = {
        verdict: samePerson ? 'SAME_PERSON' : 'DIFFERENT_PEOPLE',
        keptEmployeeId: keep,
        note: body.note as string,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: user.id,
      };
      const recordOf = (employeeId: string) =>
        biometrics.find((row) => row.employeeId === employeeId);
      const newRecord = recordOf(collision.employee.id);
      if (!samePerson) {
        clearFace(newRecord);
      } else if (keep === collision.employee.id) {
        // The new record is the real person: the older record is the duplicate.
        clearFace(newRecord);
        blockRecord(recordOf(collision.lookedLike.id));
      } else {
        blockRecord(newRecord);
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
      if (siteId !== null && !isUuid(siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      const since = query.get('since');
      if (since !== null && Number.isNaN(Date.parse(since))) {
        return validationProblem('since', 'Must be a date and time like 2026-09-22T06:00:00Z.');
      }
      if (
        siteId !== null &&
        !(mockSites.some((site) => site.id === siteId) && canSeeSite(user, siteId))
      ) {
        return notFound('No site exists with this ID.');
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
