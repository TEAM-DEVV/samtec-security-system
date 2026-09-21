import type {
  AttendanceException,
  AttendanceExceptionList,
  CurrentUser,
  ExceptionResolutionAction,
  ResolveExceptionRequest,
  WorkSegment,
  WorkSegmentList,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { mockExceptions, mockSegments } from '../data/attendance';
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
 * The mock Attendance API: worked shifts, the exception queue and resolving
 * exceptions, with the same scoping as the real API — a guard sees only
 * themselves, a supervisor only their own sites, HR reads but never resolves.
 * It keeps its own copies; tests call `resetMockAttendance()` to start fresh.
 */
function freshCopies() {
  const segments = mockSegments.map((segment) => ({ ...segment }));
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const exceptions = mockExceptions.map((exception) => ({
    ...exception,
    segments: exception.segments.map((segment) => byId.get(segment.id) ?? segment),
  }));
  return { segments, exceptions };
}

let { segments, exceptions } = freshCopies();

export function resetMockAttendance(): void {
  ({ segments, exceptions } = freshCopies());
}

const SEGMENT_STATUSES = ['CONFIRMED', 'DISPUTED', 'VOIDED'] as const;
const EXCEPTION_STATUSES = ['OPEN', 'RESOLVED', 'AUTO_CLOSED'] as const;
const EXCEPTION_TYPES = [
  'MISSING_CLOCK_OUT',
  'MISSING_CLOCK_IN',
  'UNKNOWN_EMPLOYEE',
  'INACTIVE_EMPLOYEE',
  'OVERLAP',
] as const;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_SEGMENT_MS = 16 * 3_600_000;

/** Which actions fit which exception type. */
const ACTIONS_FOR_TYPE: Record<AttendanceException['type'], ExceptionResolutionAction[]> = {
  MISSING_CLOCK_OUT: ['DISMISS', 'ADD_SEGMENT'],
  MISSING_CLOCK_IN: ['DISMISS', 'ADD_SEGMENT'],
  UNKNOWN_EMPLOYEE: ['DISMISS'],
  INACTIVE_EMPLOYEE: ['DISMISS'],
  OVERLAP: ['KEEP_SEGMENT', 'VOID_ALL'],
};

/** Every site an exception touches: two for an overlap, otherwise one. */
function sitesOf(exception: AttendanceException): string[] {
  return exception.secondSiteId === null
    ? [exception.siteId]
    : [exception.siteId, exception.secondSiteId];
}

/**
 * A supervisor sees an exception only when every site it touches is theirs,
 * so an overlap never shows them a shift at a site they do not run. Such an
 * overlap is for an administrator.
 */
function canSee(user: CurrentUser, exception: AttendanceException): boolean {
  return sitesOf(exception).every((siteId) => canSeeSite(user, siteId));
}

/** Why this user may not resolve this exception, or undefined when they may. */
function resolveRefusal(user: CurrentUser, exception: AttendanceException) {
  if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') {
    return 'role';
  }
  if (exception.employee !== null && exception.employee.id === user.employeeId) {
    return 'self';
  }
  if (!canSee(user, exception)) {
    return 'other-site';
  }
  return undefined;
}

/** The exception as this caller sees it: `allowedActions` depends on who asks. */
function forCaller(user: CurrentUser, exception: AttendanceException): AttendanceException {
  const mayResolve = exception.status === 'OPEN' && resolveRefusal(user, exception) === undefined;
  return { ...exception, allowedActions: mayResolve ? ACTIONS_FOR_TYPE[exception.type] : [] };
}

/** A guard may view only themselves; others follow the employees API's site rule. */
function mayViewEmployee(user: CurrentUser, employeeId: string): boolean {
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);
  if (!employee) return false;
  if (user.role === 'GUARD') return employee.id === user.employeeId;
  return canSeeSite(user, employee.currentSite?.id ?? null);
}

function overlaps(a: WorkSegment, startMs: number, endMs: number): boolean {
  return Date.parse(a.startedAt) < endMs && startMs < Date.parse(a.endedAt);
}

export const attendanceHandlers = [
  http.get<PathParams, never, OrProblem<WorkSegmentList>>(
    apiUrl('/attendance/segments'),
    ({ request }) => {
      const user = userForRequest(request);
      if (!user) return unauthorized('Sign in to continue.');
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const from = query.get('from') ?? '';
      const to = query.get('to') ?? '';
      if (!CALENDAR_DATE.test(from))
        return validationProblem('from', 'Must be a date like 2026-09-01.');
      if (!CALENDAR_DATE.test(to))
        return validationProblem('to', 'Must be a date like 2026-09-01.');
      const spanDays = (Date.parse(to) - Date.parse(from)) / DAY_MS;
      if (spanDays < 0 || spanDays > 31) {
        return validationProblem('to', 'Must be on or after `from`, and at most 31 days later.');
      }
      const status = query.get('status');
      if (status !== null && !isOneOf(SEGMENT_STATUSES, status)) {
        return validationProblem('status', `Must be one of ${SEGMENT_STATUSES.join(', ')}.`);
      }
      const siteId = query.get('siteId');
      const employeeId = query.get('employeeId');
      if (siteId !== null && !isUuid(siteId))
        return validationProblem('siteId', 'Must be a valid ID.');
      if (employeeId !== null && !isUuid(employeeId)) {
        return validationProblem('employeeId', 'Must be a valid ID.');
      }

      // A site or employee the caller may not see "does not exist" (404),
      // exactly like one that really does not exist.
      if (
        siteId !== null &&
        !(mockSites.some((site) => site.id === siteId) && canSeeSite(user, siteId))
      ) {
        return notFound('No site exists with this ID.');
      }
      if (employeeId !== null && !mayViewEmployee(user, employeeId)) {
        return notFound('No employee exists with this ID.');
      }

      const matches = segments
        .filter((segment) => segment.workDate >= from && segment.workDate <= to)
        .filter((segment) =>
          status === null ? segment.status !== 'VOIDED' : segment.status === status,
        )
        .filter((segment) => siteId === null || segment.siteId === siteId)
        .filter((segment) => employeeId === null || segment.employee.id === employeeId)
        .filter((segment) => user.role !== 'GUARD' || segment.employee.id === user.employeeId)
        .filter((segment) => user.role === 'GUARD' || canSeeSite(user, segment.siteId))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<WorkSegmentList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.get<PathParams, never, OrProblem<AttendanceExceptionList>>(
    apiUrl('/attendance/exceptions'),
    ({ request }) => {
      const user = userForRequest(request);
      if (!user) return unauthorized('Sign in to continue.');
      if (user.role === 'GUARD') return forbidden();
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const status = query.get('status') ?? 'OPEN';
      if (!isOneOf(EXCEPTION_STATUSES, status)) {
        return validationProblem('status', `Must be one of ${EXCEPTION_STATUSES.join(', ')}.`);
      }
      const type = query.get('type');
      if (type !== null && !isOneOf(EXCEPTION_TYPES, type)) {
        return validationProblem('type', `Must be one of ${EXCEPTION_TYPES.join(', ')}.`);
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

      const matches = exceptions
        .filter((exception) => exception.status === status)
        .filter((exception) => type === null || exception.type === type)
        .filter(
          (exception) =>
            siteId === null || exception.siteId === siteId || exception.secondSiteId === siteId,
        )
        .filter((exception) => canSee(user, exception))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
        .map((exception) => forCaller(user, exception));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<AttendanceExceptionList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.get<{ exceptionId: string }, never, OrProblem<AttendanceException>>(
    apiUrl('/attendance/exceptions/:exceptionId'),
    ({ params, request }) => {
      const user = userForRequest(request);
      if (!user) return unauthorized('Sign in to continue.');
      if (user.role === 'GUARD') return forbidden();
      if (!isUuid(params.exceptionId)) {
        return validationProblem('exceptionId', 'Must be a valid ID.');
      }
      const exception = exceptions.find((candidate) => candidate.id === params.exceptionId);
      return exception && canSee(user, exception)
        ? HttpResponse.json<AttendanceException>(forCaller(user, exception))
        : notFound('No exception exists with this ID.');
    },
  ),

  http.post<{ exceptionId: string }, ResolveExceptionRequest, OrProblem<AttendanceException>>(
    apiUrl('/attendance/exceptions/:exceptionId/resolve'),
    async ({ params, request }) => {
      const user = userForRequest(request);
      if (!user) return unauthorized('Sign in to continue.');
      if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') return forbidden();
      if (!isUuid(params.exceptionId)) {
        return validationProblem('exceptionId', 'Must be a valid ID.');
      }
      const exception = exceptions.find((candidate) => candidate.id === params.exceptionId);
      if (!exception || !canSee(user, exception)) {
        return notFound('No exception exists with this ID.');
      }
      if (resolveRefusal(user, exception)) {
        // Their own attendance, or an overlap reaching a site they do not run.
        return forbidden();
      }
      if (exception.status !== 'OPEN') {
        return conflict('This exception has already been dealt with.');
      }

      const body = await request.json();
      if (!ACTIONS_FOR_TYPE[exception.type].includes(body.action)) {
        return validationProblem(
          'action',
          `For this exception, choose one of ${ACTIONS_FOR_TYPE[exception.type].join(', ')}.`,
        );
      }
      if (typeof body.note !== 'string' || body.note.length < 3 || body.note.length > 500) {
        return validationProblem('note', 'Explain the decision in 3 to 500 characters.');
      }

      let resolutionSegmentId: string | null = null;
      if (body.action === 'ADD_SEGMENT') {
        const start = Date.parse(body.startedAt);
        const end = Date.parse(body.endedAt);
        const punchTime = exception.punch ? Date.parse(exception.punch.deviceTime) : Number.NaN;
        if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
          return validationProblem('endedAt', 'The end must come after the start.');
        }
        if (end - start > MAX_SEGMENT_MS) {
          return validationProblem('endedAt', 'A shift can be at most 16 hours long.');
        }
        if (end > Date.now())
          return validationProblem('endedAt', 'The end cannot be in the future.');
        if (!(start <= punchTime && punchTime <= end)) {
          return validationProblem('startedAt', "The hours must include the real punch's time.");
        }
        const employee = exception.employee;
        if (
          employee &&
          segments.some(
            (segment) =>
              segment.employee.id === employee.id &&
              segment.status !== 'VOIDED' &&
              overlaps(segment, start, end),
          )
        ) {
          return conflict('These hours overlap another shift of this employee.');
        }
        if (employee) {
          const manual: WorkSegment = {
            id: crypto.randomUUID(),
            employee,
            siteId: exception.siteId,
            workDate: new Date(start).toISOString().slice(0, 10),
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(end).toISOString(),
            workedMinutes: Math.floor((end - start) / 60_000),
            basis: 'MANUAL',
            status: 'CONFIRMED',
            clockInPunchId: null,
            clockOutPunchId: null,
          };
          segments.push(manual);
          resolutionSegmentId = manual.id;
        }
      }
      if (body.action === 'KEEP_SEGMENT') {
        const kept = exception.segments.find((segment) => segment.id === body.segmentId);
        if (!kept) {
          return validationProblem('segmentId', "Choose one of this exception's two shifts.");
        }
        for (const segment of exception.segments) {
          segment.status = segment.id === kept.id ? 'CONFIRMED' : 'VOIDED';
        }
      }
      if (body.action === 'VOID_ALL') {
        for (const segment of exception.segments) {
          segment.status = 'VOIDED';
        }
      }

      exception.status = 'RESOLVED';
      exception.resolutionSegmentId = resolutionSegmentId;
      exception.resolution = {
        action: body.action,
        note: body.note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: user.id,
      };
      return HttpResponse.json<AttendanceException>(forCaller(user, exception));
    },
  ),
];
