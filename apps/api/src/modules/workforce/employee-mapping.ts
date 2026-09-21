import type {
  Employee as ApiEmployee,
  EmployeeListItem,
  PostSummary,
  ShiftPatternSummary,
  SiteSummary,
} from '@samtec/contracts';
import { toIsoDate } from '../../common/dates.js';
import type { Employee, Post, ShiftPattern, Site } from '../../generated/prisma/client.js';
import { toShiftTime } from './workforce.schemas.js';

/**
 * Turns database rows into exactly the shapes the contract promises. Pure
 * functions, so the unit tests can prove every field — especially that the
 * Ghana Card number only appears when the viewer is allowed to see it.
 */

export interface EmployeeWithSite {
  employee: Employee;
  /** The site the employee is posted to today, or null. */
  currentSite: Site | null;
  /** The post at that site, when one is set. */
  currentPost?: Post | null;
  /** The shift pattern they work, when one is set. */
  currentShiftPattern?: ShiftPattern | null;
}

function toSiteSummary(site: Site | null): SiteSummary | null {
  return site ? { id: site.id, code: site.code, name: site.name } : null;
}

function toPostSummary(post: Post | null | undefined): PostSummary | null {
  return post ? { id: post.id, name: post.name } : null;
}

function toShiftPatternSummary(
  pattern: ShiftPattern | null | undefined,
): ShiftPatternSummary | null {
  return pattern
    ? {
        id: pattern.id,
        name: pattern.name,
        startTime: toShiftTime(pattern.startMinutes),
        endTime: toShiftTime(pattern.endMinutes),
      }
    : null;
}

/** First, other and last names joined for display: "Kwame Kofi Mensah". */
export function fullNameOf(
  employee: Pick<Employee, 'firstName' | 'otherNames' | 'lastName'>,
): string {
  return [employee.firstName, employee.otherNames, employee.lastName]
    .filter((part) => part !== null && part.length > 0)
    .join(' ');
}

/** The short list form. Sensitive identity fields are left out on purpose. */
export function toEmployeeListItem({ employee, currentSite }: EmployeeWithSite): EmployeeListItem {
  return {
    id: employee.id,
    staffNumber: employee.staffNumber,
    fullName: fullNameOf(employee),
    position: employee.position,
    status: employee.status,
    biometricEnrolledAt: employee.biometricEnrolledAt?.toISOString() ?? null,
    currentSite: toSiteSummary(currentSite),
    hireDate: toIsoDate(employee.hireDate),
  };
}

/**
 * The full record. The Ghana Card number is included only when
 * `includeGhanaCardNumber` is true: ADMIN, HR_PAYROLL, or the employee
 * themselves (data minimisation, docs/plan/05-api-contract.md).
 */
export function toEmployeeDetail(
  { employee, currentSite, currentPost, currentShiftPattern }: EmployeeWithSite,
  includeGhanaCardNumber: boolean,
): ApiEmployee {
  return {
    id: employee.id,
    staffNumber: employee.staffNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    otherNames: employee.otherNames,
    fullName: fullNameOf(employee),
    phone: employee.phone,
    email: employee.email,
    ...(includeGhanaCardNumber ? { ghanaCardNumber: employee.ghanaCardNumber } : {}),
    position: employee.position,
    status: employee.status,
    biometricEnrolledAt: employee.biometricEnrolledAt?.toISOString() ?? null,
    hireDate: toIsoDate(employee.hireDate),
    terminationDate: employee.terminationDate ? toIsoDate(employee.terminationDate) : null,
    currentSite: toSiteSummary(currentSite),
    currentPost: toPostSummary(currentPost),
    currentShiftPattern: toShiftPatternSummary(currentShiftPattern),
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
  };
}
