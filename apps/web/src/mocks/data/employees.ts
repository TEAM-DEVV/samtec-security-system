import type { Employee, EmployeeStatus } from '@samtec/contracts';
import { mockSites } from './sites';

interface MockPerson {
  firstName: string;
  otherNames?: string;
  lastName: string;
  position: string;
  status: EmployeeStatus;
  hireDate: string;
  siteCode: string | null;
  terminationDate?: string;
}

// Fictional people only. Never copy real employee data into mocks (see SECURITY.md).
const people: MockPerson[] = [
  {
    firstName: 'Kwame',
    otherNames: 'Kofi',
    lastName: 'Mensah',
    position: 'Security Guard',
    status: 'ACTIVE',
    hireDate: '2024-03-11',
    siteCode: 'ACC-01',
  },
  {
    firstName: 'Abena',
    lastName: 'Owusu',
    position: 'Senior Guard',
    status: 'PENDING_ENROLLMENT',
    hireDate: '2026-09-01',
    siteCode: null,
  },
  {
    firstName: 'Yaw',
    lastName: 'Boateng',
    position: 'Site Supervisor',
    status: 'ACTIVE',
    hireDate: '2021-06-14',
    siteCode: 'ACC-01',
  },
  {
    firstName: 'Akua',
    lastName: 'Asante',
    position: 'Security Guard',
    status: 'ACTIVE',
    hireDate: '2023-11-02',
    siteCode: 'ACC-02',
  },
  {
    firstName: 'Emmanuel',
    lastName: 'Tetteh',
    position: 'Patrol Officer',
    status: 'ACTIVE',
    hireDate: '2022-02-21',
    siteCode: 'TEM-01',
  },
  {
    firstName: 'Grace',
    lastName: 'Adjei',
    position: 'Security Guard',
    status: 'SUSPENDED',
    hireDate: '2020-08-17',
    siteCode: 'TEM-01',
  },
  {
    firstName: 'Ibrahim',
    lastName: 'Iddrisu',
    position: 'Security Guard',
    status: 'ACTIVE',
    hireDate: '2025-01-06',
    siteCode: 'KSI-01',
  },
  {
    firstName: 'Esi',
    lastName: 'Quaye',
    position: 'Senior Guard',
    status: 'ACTIVE',
    hireDate: '2019-10-28',
    siteCode: 'KSI-01',
  },
  {
    firstName: 'Kojo',
    lastName: 'Frimpong',
    position: 'Security Guard',
    status: 'TERMINATED',
    hireDate: '2022-05-09',
    siteCode: null,
    terminationDate: '2026-07-31',
  },
  {
    firstName: 'Selorm',
    lastName: 'Agbeko',
    position: 'Security Guard',
    status: 'PENDING_ENROLLMENT',
    hireDate: '2026-09-08',
    siteCode: 'TKD-01',
  },
  {
    firstName: 'Afua',
    otherNames: 'Serwaa',
    lastName: 'Darko',
    position: 'Security Guard',
    status: 'ACTIVE',
    hireDate: '2024-12-02',
    siteCode: 'TKD-01',
  },
  {
    firstName: 'Daniel',
    lastName: 'Opoku',
    position: 'Site Supervisor',
    status: 'ACTIVE',
    hireDate: '2020-03-16',
    siteCode: 'ACC-02',
  },
];

const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * Full employee records, shaped exactly like the contract's `Employee` schema,
 * as an HR user would see them. The handlers withhold the Ghana Card number
 * and hide other sites' people for roles that may not see them, like the real API.
 */
export const mockEmployees: Employee[] = people.map((person, index) => {
  const number = index + 1;
  const site = mockSites.find((candidate) => candidate.code === person.siteCode);
  // Everyone except new starters enrolled their biometrics the day after being hired.
  const enrolledAt = new Date(Date.parse(`${person.hireDate}T10:00:00Z`) + DAY_IN_MILLISECONDS);
  return {
    id: `01927c3e-5a4b-7c8d-9e0f-${String(number).padStart(12, '0')}`,
    staffNumber: `SMT-${String(number).padStart(5, '0')}`,
    firstName: person.firstName,
    lastName: person.lastName,
    otherNames: person.otherNames ?? null,
    fullName: [person.firstName, person.otherNames, person.lastName].filter(Boolean).join(' '),
    // Obviously fake numbers that still match the real formats.
    phone: `+233200000${String(number).padStart(3, '0')}`,
    email: null,
    ghanaCardNumber: `GHA-000000${String(number).padStart(3, '0')}-${number % 10}`,
    position: person.position,
    status: person.status,
    biometricEnrolledAt: person.status === 'PENDING_ENROLLMENT' ? null : enrolledAt.toISOString(),
    hireDate: person.hireDate,
    terminationDate: person.terminationDate ?? null,
    currentSite: site ? { id: site.id, code: site.code, name: site.name } : null,
    createdAt: `${person.hireDate}T09:00:00Z`,
    updatedAt: '2026-09-10T12:00:00Z',
  };
});
