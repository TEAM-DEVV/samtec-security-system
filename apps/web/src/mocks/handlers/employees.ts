import type { Employee, EmployeeList, EmployeeListItem } from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse, http, type PathParams } from 'msw';
import { EMPLOYEE_STATUSES } from '@/components/employee-status-badge';
import { mockEmployees } from '../data/employees';
import {
  apiUrl,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { userForRequest } from './auth';

export const employeeHandlers = [
  http.get<PathParams, DefaultBodyType, OrProblem<EmployeeList>>(
    apiUrl('/employees'),
    ({ request }) => {
      if (!userForRequest(request)) {
        return unauthorized('Sign in to continue.');
      }
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
      const matches = mockEmployees
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

  http.get<{ employeeId: string }, DefaultBodyType, OrProblem<Employee>>(
    apiUrl('/employees/:employeeId'),
    ({ request, params }) => {
      if (!userForRequest(request)) {
        return unauthorized('Sign in to continue.');
      }
      if (!isUuid(params.employeeId)) {
        return validationProblem('employeeId', 'Must be a valid ID.');
      }
      const employee = mockEmployees.find((candidate) => candidate.id === params.employeeId);
      return employee
        ? HttpResponse.json<Employee>(employee)
        : notFound('No employee exists with this ID.');
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
