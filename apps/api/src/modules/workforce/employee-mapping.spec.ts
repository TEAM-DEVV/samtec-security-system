import { describe, expect, it } from 'vitest';
import type { Employee, Site } from '../../generated/prisma/client.js';
import { fullNameOf, toEmployeeDetail, toEmployeeListItem } from './employee-mapping.js';

const employee: Employee = {
  id: '01927c3e-5a4b-7c8d-9e0f-000000000001',
  companyId: '01927c3e-0000-7000-8000-000000000001',
  staffNumber: 'SMT-00042',
  firstName: 'Kwame',
  lastName: 'Mensah',
  otherNames: 'Kofi',
  phone: '+233200000042',
  email: null,
  ghanaCardNumber: 'GHA-000000042-2',
  position: 'Security Guard',
  status: 'ACTIVE',
  biometricEnrolledAt: new Date('2024-03-12T10:00:00Z'),
  hireDate: new Date('2024-03-11T00:00:00Z'),
  terminationDate: null,
  terminationReason: null,
  terminationNote: null,
  createdAt: new Date('2024-03-08T09:15:00Z'),
  updatedAt: new Date('2026-08-30T14:02:11Z'),
};

const site: Site = {
  id: '01927c3e-1111-7aaa-8bbb-000000000001',
  companyId: employee.companyId,
  code: 'ACC-01',
  name: 'Ridge Towers Office Complex',
  clientName: 'Ridge Towers Management Ltd',
  region: 'GREATER_ACCRA',
  city: 'Accra',
  status: 'ACTIVE',
  createdAt: new Date('2024-01-15T08:00:00Z'),
  updatedAt: new Date('2026-09-01T10:30:00Z'),
};

describe('fullNameOf', () => {
  it('joins first, other and last names', () => {
    expect(fullNameOf(employee)).toBe('Kwame Kofi Mensah');
    expect(fullNameOf({ ...employee, otherNames: null })).toBe('Kwame Mensah');
  });
});

describe('toEmployeeListItem', () => {
  it('never contains identity fields, only what the list screen needs', () => {
    const item = toEmployeeListItem({ employee, currentSite: site });

    expect(item).toEqual({
      id: employee.id,
      staffNumber: 'SMT-00042',
      fullName: 'Kwame Kofi Mensah',
      position: 'Security Guard',
      status: 'ACTIVE',
      biometricEnrolledAt: '2024-03-12T10:00:00.000Z',
      currentSite: { id: site.id, code: 'ACC-01', name: 'Ridge Towers Office Complex' },
      hireDate: '2024-03-11',
    });
    expect(item).not.toHaveProperty('ghanaCardNumber');
    expect(item).not.toHaveProperty('phone');
  });
});

describe('toEmployeeDetail', () => {
  it('includes the Ghana Card number only for viewers allowed to see it', () => {
    const forHr = toEmployeeDetail({ employee, currentSite: site }, true);
    const forSupervisor = toEmployeeDetail({ employee, currentSite: site }, false);

    expect(forHr.ghanaCardNumber).toBe('GHA-000000042-2');
    expect(forSupervisor).not.toHaveProperty('ghanaCardNumber');
  });

  it('formats calendar dates as YYYY-MM-DD and timestamps as ISO', () => {
    const detail = toEmployeeDetail({ employee, currentSite: null }, true);

    expect(detail.hireDate).toBe('2024-03-11');
    expect(detail.terminationDate).toBeNull();
    expect(detail.createdAt).toBe('2024-03-08T09:15:00.000Z');
    expect(detail.currentSite).toBeNull();
  });
});
