import { attendanceHandlers } from './attendance';
import { authHandlers } from './auth';
import { biometricHandlers } from './biometrics';
import { detectionHandlers } from './detection';
import { deviceHandlers } from './devices';
import { employeeHandlers } from './employees';
import { payrollHandlers } from './payroll';
import { reportHandlers } from './reports';
import { rosterHandlers } from './rosters';
import { siteHandlers } from './sites';
import { systemHandlers } from './system';
import { userHandlers } from './users';

/**
 * The mock API: pretend versions of the real endpoints, so the dashboard can be
 * built and tested before the backend exists. There is one file per area of
 * the contract, and shared helpers live in `../helpers.ts`.
 *
 * Rules for every handler:
 * - Response bodies use the contract types, so TypeScript catches mismatches.
 * - Each handler lists every body it can send back (its success shape and
 *   ProblemDetails), so TypeScript checks all of them.
 * - Behave the way the contract describes, including its errors (400, 401, 404).
 * - When `openapi.yaml` changes, update these handlers in the same pull request.
 */
export const handlers = [
  ...systemHandlers,
  ...authHandlers,
  ...employeeHandlers,
  ...siteHandlers,
  ...rosterHandlers,
  ...userHandlers,
  ...deviceHandlers,
  ...attendanceHandlers,
  ...biometricHandlers,
  ...payrollHandlers,
  ...detectionHandlers,
  ...reportHandlers,
];
