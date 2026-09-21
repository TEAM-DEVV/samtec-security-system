import type {
  CreateEmployeeRequest,
  Employee,
  EmployeeList,
  EmployeeListItem,
  TerminateEmployeeRequest,
  UpdateEmployeeRequest,
} from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { EMPLOYEE_STATUSES } from '@/components/employee-status-badge';
import { mockEmployees } from '../data/employees';
import { mockPosts, mockShiftPatterns } from '../data/rosters';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  conflict,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  validationProblem,
} from '../helpers';

/**
 * The mock API keeps its own copy of the employees, so the write handlers can
 * change it without touching the original data. Tests call
 * `resetMockEmployees()` to start fresh.
 */
let employees: Employee[] = mockEmployees.map((employee) => ({ ...employee }));

export function resetMockEmployees(): void {
  employees = mockEmployees.map((employee) => ({ ...employee }));
}

const TERMINATION_REASONS = [
  'RESIGNED',
  'DISMISSED',
  'CONTRACT_ENDED',
  'ABSCONDED',
  'DECEASED',
  'OTHER',
] as const;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The site summary for a mock site ID, or undefined when no such site exists. */
function siteSummaryFor(siteId: string) {
  const site = mockSites.find((candidate) => candidate.id === siteId);
  return site ? { id: site.id, code: site.code, name: site.name } : undefined;
}

// Phase 1: once the dashboard signs in, make these handlers answer 401 without
// an access token, like the real API.
export const employeeHandlers = [
  http.get<PathParams, DefaultBodyType, OrProblem<EmployeeList>>(
    apiUrl('/employees'),
    ({ request }) => {
      const query = new URL(request.url).searchParams;

      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const status = query.get('status');
      if (status !== null && !isOneOf(EMPLOYEE_STATUSES, status)) {
        return validationProblem('status', `Must be one of ${EMPLOYEE_STATUSES.join(', ')}.`);
      }
      const siteId = query.get('siteId');
      if (siteId !== null && !isUuid(siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      const search = query.get('search');
      if (search !== null && (search.length < 2 || search.length > 100)) {
        return validationProblem('search', 'Search must be 2 to 100 characters long.');
      }

      const term = search?.toLowerCase();
      const matches = employees
        .filter((employee) => status === null || employee.status === status)
        .filter((employee) => siteId === null || employee.currentSite?.id === siteId)
        .filter(
          (employee) =>
            term === undefined ||
            [employee.staffNumber, employee.firstName, employee.lastName].some((value) =>
              value.toLowerCase().includes(term),
            ),
        )
        .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber))
        .map(toListItem);

      const page = pageOf(matches, limit, query.get('cursor'));
      if (!page) {
        return validationProblem(
          'cursor',
          'The cursor is not valid. Start again from the first page.',
        );
      }
      return HttpResponse.json<EmployeeList>(page);
    },
  ),

  http.post<PathParams, CreateEmployeeRequest, OrProblem<Employee>>(
    apiUrl('/employees'),
    async ({ request }) => {
      const body = await request.json();

      if (!body.firstName) return validationProblem('firstName', 'Required.');
      if (!body.lastName) return validationProblem('lastName', 'Required.');
      if (!/^\+233\d{9}$/.test(body.phone ?? '')) {
        return validationProblem('phone', 'Must look like +233241234567.');
      }
      if (!/^GHA-\d{9}-\d$/.test(body.ghanaCardNumber ?? '')) {
        return validationProblem('ghanaCardNumber', 'Must look like GHA-123456789-0.');
      }
      if (!body.position || body.position.length < 2) {
        return validationProblem('position', 'Required.');
      }
      if (!CALENDAR_DATE.test(body.hireDate ?? '')) {
        return validationProblem('hireDate', 'Must be a date like 2026-09-15.');
      }
      if (employees.some((employee) => employee.ghanaCardNumber === body.ghanaCardNumber)) {
        return conflict('An employee with this Ghana Card number is already registered.');
      }
      // An optional first posting, like the real API's site assignment.
      if (body.postId !== undefined && body.siteId === undefined) {
        return validationProblem('postId', 'Send `siteId` too — a post belongs to a site.');
      }
      if (body.shiftPatternId !== undefined && body.siteId === undefined) {
        return validationProblem(
          'shiftPatternId',
          'Send `siteId` too — a shift is worked at a site.',
        );
      }
      let currentSite = null;
      let currentPost = null;
      let currentShiftPattern = null;
      if (body.siteId !== undefined) {
        const summary = isUuid(body.siteId) ? siteSummaryFor(body.siteId) : undefined;
        if (!summary) {
          return validationProblem('siteId', 'No site exists with this ID.');
        }
        currentSite = summary;
        if (body.postId !== undefined) {
          const post = mockPosts.find((p) => p.id === body.postId && p.siteId === body.siteId);
          if (!post) {
            return validationProblem('postId', 'No post with this ID exists at this site.');
          }
          currentPost = { id: post.id, name: post.name };
        }
        if (body.shiftPatternId !== undefined) {
          const pattern = mockShiftPatterns.find((p) => p.id === body.shiftPatternId);
          if (!pattern) {
            return validationProblem('shiftPatternId', 'No shift pattern exists with this ID.');
          }
          currentShiftPattern = {
            id: pattern.id,
            name: pattern.name,
            startTime: pattern.startTime,
            endTime: pattern.endTime,
          };
        }
      }

      const nextNumber =
        Math.max(0, ...employees.map((employee) => Number(employee.staffNumber.slice(4)))) + 1;
      const now = new Date().toISOString();
      const employee: Employee = {
        id: crypto.randomUUID(),
        staffNumber: `SMT-${String(nextNumber).padStart(5, '0')}`,
        firstName: body.firstName,
        lastName: body.lastName,
        otherNames: body.otherNames ?? null,
        fullName: [body.firstName, body.otherNames, body.lastName].filter(Boolean).join(' '),
        phone: body.phone,
        email: body.email ?? null,
        ghanaCardNumber: body.ghanaCardNumber,
        position: body.position,
        status: 'PENDING_ENROLLMENT',
        biometricEnrolledAt: null,
        hireDate: body.hireDate,
        terminationDate: null,
        currentSite,
        currentPost,
        currentShiftPattern,
        createdAt: now,
        updatedAt: now,
      };
      employees.push(employee);
      return HttpResponse.json<Employee>(employee, {
        status: 201,
        headers: { Location: `/api/v1/employees/${employee.id}` },
      });
    },
  ),

  http.get<{ employeeId: string }, DefaultBodyType, OrProblem<Employee>>(
    apiUrl('/employees/:employeeId'),
    ({ params }) => {
      if (!isUuid(params.employeeId)) {
        return validationProblem('employeeId', 'Must be a valid ID.');
      }
      const employee = employees.find((candidate) => candidate.id === params.employeeId);
      return employee
        ? HttpResponse.json<Employee>(employee)
        : notFound('No employee exists with this ID.');
    },
  ),

  http.patch<{ employeeId: string }, UpdateEmployeeRequest, OrProblem<Employee>>(
    apiUrl('/employees/:employeeId'),
    async ({ params, request }) => {
      if (!isUuid(params.employeeId)) {
        return validationProblem('employeeId', 'Must be a valid ID.');
      }
      const employee = employees.find((candidate) => candidate.id === params.employeeId);
      if (!employee) {
        return notFound('No employee exists with this ID.');
      }
      if (employee.status === 'TERMINATED') {
        return conflict(
          'This employee has left the company. Their record is kept as history and cannot be changed.',
        );
      }

      const body = await request.json();
      // Like the real API's strict schema: any field we did not ask for is a 400.
      const allowed = [
        'firstName',
        'lastName',
        'otherNames',
        'phone',
        'email',
        'position',
        'siteId',
        'postId',
        'shiftPatternId',
      ];
      const unknown = Object.keys(body).find((key) => !allowed.includes(key));
      if (unknown !== undefined) {
        return validationProblem(unknown, 'Unrecognized field.');
      }
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      // A post or shift only makes sense as part of a posting (like the real API).
      if (body.postId !== undefined && body.siteId === undefined) {
        return validationProblem(
          'postId',
          'Send `siteId` too — changing the post starts a fresh posting.',
        );
      }
      if (body.shiftPatternId !== undefined && body.siteId === undefined) {
        return validationProblem(
          'shiftPatternId',
          'Send `siteId` too — changing the shift starts a fresh posting.',
        );
      }
      // `siteId` moves the posting: a new site, or null to unassign.
      if (body.siteId !== undefined) {
        if (body.siteId === null) {
          if (body.postId != null) {
            return validationProblem(
              'postId',
              'Send a real `siteId` too — a post belongs to a site.',
            );
          }
          if (body.shiftPatternId != null) {
            return validationProblem(
              'shiftPatternId',
              'Send a real `siteId` too — a shift is worked at a site.',
            );
          }
          employee.currentSite = null;
          employee.currentPost = null;
          employee.currentShiftPattern = null;
        } else {
          const summary = isUuid(body.siteId) ? siteSummaryFor(body.siteId) : undefined;
          if (!summary) {
            return validationProblem('siteId', 'No site exists with this ID.');
          }
          employee.currentSite = summary;
          const post =
            body.postId == null
              ? null
              : mockPosts.find((p) => p.id === body.postId && p.siteId === body.siteId);
          if (post === undefined) {
            return validationProblem('postId', 'No post with this ID exists at this site.');
          }
          const pattern =
            body.shiftPatternId == null
              ? null
              : mockShiftPatterns.find((p) => p.id === body.shiftPatternId);
          if (pattern === undefined) {
            return validationProblem('shiftPatternId', 'No shift pattern exists with this ID.');
          }
          employee.currentPost = post ? { id: post.id, name: post.name } : null;
          employee.currentShiftPattern = pattern
            ? {
                id: pattern.id,
                name: pattern.name,
                startTime: pattern.startTime,
                endTime: pattern.endTime,
              }
            : null;
        }
      }

      if (body.firstName !== undefined) employee.firstName = body.firstName;
      if (body.lastName !== undefined) employee.lastName = body.lastName;
      if (body.otherNames !== undefined) employee.otherNames = body.otherNames;
      if (body.phone !== undefined) employee.phone = body.phone;
      if (body.email !== undefined) employee.email = body.email;
      if (body.position !== undefined) employee.position = body.position;
      employee.fullName = [employee.firstName, employee.otherNames, employee.lastName]
        .filter(Boolean)
        .join(' ');
      employee.updatedAt = new Date().toISOString();
      return HttpResponse.json<Employee>(employee);
    },
  ),

  http.post<{ employeeId: string }, TerminateEmployeeRequest, OrProblem<Employee>>(
    apiUrl('/employees/:employeeId/terminate'),
    async ({ params, request }) => {
      if (!isUuid(params.employeeId)) {
        return validationProblem('employeeId', 'Must be a valid ID.');
      }
      const employee = employees.find((candidate) => candidate.id === params.employeeId);
      if (!employee) {
        return notFound('No employee exists with this ID.');
      }
      if (employee.status === 'TERMINATED') {
        return conflict('This employee has already been terminated.');
      }

      const body = await request.json();
      if (!CALENDAR_DATE.test(body.effectiveDate ?? '')) {
        return validationProblem('effectiveDate', 'Must be a date like 2026-09-15.');
      }
      if (!isOneOf(TERMINATION_REASONS, body.reason ?? '')) {
        return validationProblem('reason', `Must be one of ${TERMINATION_REASONS.join(', ')}.`);
      }
      if (body.reason === 'OTHER' && !body.note) {
        return validationProblem('note', 'Explain the reason in `note` when the reason is OTHER.');
      }
      if (body.effectiveDate < employee.hireDate) {
        return validationProblem(
          'effectiveDate',
          'The last working day cannot be before the hire date.',
        );
      }

      employee.status = 'TERMINATED';
      employee.terminationDate = body.effectiveDate;
      employee.currentSite = null;
      employee.updatedAt = new Date().toISOString();
      return HttpResponse.json<Employee>(employee);
    },
  ),
];

/** The short list form of an employee, without sensitive identity fields (like the real API). */
function toListItem(employee: Employee): EmployeeListItem {
  return {
    id: employee.id,
    staffNumber: employee.staffNumber,
    fullName: employee.fullName,
    position: employee.position,
    status: employee.status,
    biometricEnrolledAt: employee.biometricEnrolledAt,
    currentSite: employee.currentSite,
    hireDate: employee.hireDate,
  };
}
