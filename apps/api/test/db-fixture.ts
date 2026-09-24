import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword, TEST_ONLY_SCRYPT_PARAMS } from '../src/modules/identity/password.js';
import { deriveKey, sealSecret } from '../src/modules/identity/secret-box.js';
import { DB_TEST_AUTH_SECRET } from './create-db-test-app.js';

/**
 * A fictional company for the database-backed tests. It lives beside any
 * other data in the database (its own `companyId` keeps it separate), and is
 * wiped and rebuilt before each test run. Audit rows are the one exception:
 * the audit table is append-only by design, so they simply accumulate.
 */

export const TEST_COMPANY_ID = '01927c3e-7e57-7000-8000-000000000001';
export const SITE_1_ID = '01927c3e-7e57-7000-8000-00000000f001';
export const SITE_2_ID = '01927c3e-7e57-7000-8000-00000000f002';
export const SUPERVISOR_EMPLOYEE_ID = '01927c3e-7e57-7000-8000-00000000e001';
export const GUARD_EMPLOYEE_ID = '01927c3e-7e57-7000-8000-00000000e002';
export const OTHER_SITE_EMPLOYEE_ID = '01927c3e-7e57-7000-8000-00000000e003';
export const TERMINATED_EMPLOYEE_ID = '01927c3e-7e57-7000-8000-00000000e004';

export const TEST_PASSWORD = 'demo-password';
/** The admin's authenticator secret, so tests can compute real codes. */
export const ADMIN_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

export const EMAILS = {
  admin: 'admin@dbtest.example',
  /** A second administrator, for the rules about two admins acting on each other. */
  admin2: 'admin2@dbtest.example',
  hr: 'hr@dbtest.example',
  supervisor: 'supervisor@dbtest.example',
  guard: 'guard@dbtest.example',
};

export function openFixtureDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/**
 * Deletes the test company's rows (audit rows excepted) and builds them afresh.
 *
 * **Never add payroll deletes here.** Nothing in payroll can be deleted — that
 * is one of the rules the database enforces — so the call would simply throw.
 * Worse, an employee carrying pay terms cannot be deleted either, because the
 * pay terms reference it with `onDelete: Restrict` and cannot be cleared out of
 * the way. One payroll row written for `TEST_COMPANY_ID` would therefore break
 * this function for **every** database-backed test at once, permanently, with
 * no way back except `pnpm db:reset`.
 *
 * A test that needs payroll rows makes its own company instead. See
 * `payroll-rules.e2e-spec.ts` and `src/modules/payroll/README.md`.
 */
export async function resetFixture(prisma: PrismaClient): Promise<void> {
  // Children first, so no foreign key is left pointing at nothing.
  await prisma.userSession.deleteMany({ where: { user: { companyId: TEST_COMPANY_ID } } });
  await prisma.authChallenge.deleteMany({ where: { user: { companyId: TEST_COMPANY_ID } } });
  await prisma.user.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.siteAssignment.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.employmentPeriod.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.employee.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.post.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.shiftPattern.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.site.deleteMany({ where: { companyId: TEST_COMPANY_ID } });
  await prisma.signInThrottle.deleteMany({});

  await prisma.company.upsert({
    where: { id: TEST_COMPANY_ID },
    update: {},
    create: { id: TEST_COMPANY_ID, name: 'DB Test Security Ltd' },
  });

  await prisma.site.createMany({
    data: [site(SITE_1_ID, 'TSA-01', 'Test Towers'), site(SITE_2_ID, 'TSB-01', 'Test Warehouse')],
  });

  await prisma.employee.createMany({
    data: [
      employee(SUPERVISOR_EMPLOYEE_ID, 'SMT-90001', 'Yaw', 'Owusu', 'Site Supervisor', 'ACTIVE'),
      employee(GUARD_EMPLOYEE_ID, 'SMT-90002', 'Kwame', 'Mensah', 'Security Guard', 'ACTIVE'),
      employee(OTHER_SITE_EMPLOYEE_ID, 'SMT-90003', 'Abena', 'Boateng', 'Security Guard', 'ACTIVE'),
      employee(
        TERMINATED_EMPLOYEE_ID,
        'SMT-90004',
        'Kojo',
        'Adjei',
        'Security Guard',
        'TERMINATED',
      ),
    ],
  });

  await prisma.siteAssignment.createMany({
    data: [
      assignment(SUPERVISOR_EMPLOYEE_ID, SITE_1_ID),
      assignment(GUARD_EMPLOYEE_ID, SITE_1_ID),
      assignment(OTHER_SITE_EMPLOYEE_ID, SITE_2_ID),
    ],
  });

  // One employment period each: open for current staff, closed for the leaver.
  await prisma.employmentPeriod.createMany({
    data: [
      period(SUPERVISOR_EMPLOYEE_ID),
      period(GUARD_EMPLOYEE_ID),
      period(OTHER_SITE_EMPLOYEE_ID),
      {
        ...period(TERMINATED_EMPLOYEE_ID),
        endsOn: new Date('2026-08-31T00:00:00Z'),
        terminationReason: 'RESIGNED' as const,
      },
    ],
  });

  // Weak (fast) hashing parameters: fine for tests, never for real accounts.
  const passwordHash = await hashPassword(TEST_PASSWORD, TEST_ONLY_SCRYPT_PARAMS);
  const boxKey = deriveKey(DB_TEST_AUTH_SECRET, 'secret-box');
  await prisma.user.createMany({
    data: [
      {
        companyId: TEST_COMPANY_ID,
        email: EMAILS.admin,
        passwordHash,
        fullName: 'Efua Admin',
        role: 'ADMIN',
        // The admin already uses an authenticator app, with a secret the
        // tests know, so they can compute real codes.
        twoFactorSecretEncrypted: sealSecret(ADMIN_TOTP_SECRET, boxKey),
        twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        companyId: TEST_COMPANY_ID,
        email: EMAILS.admin2,
        passwordHash,
        fullName: 'Ama Admin',
        role: 'ADMIN',
        twoFactorSecretEncrypted: sealSecret(ADMIN_TOTP_SECRET, boxKey),
        twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        companyId: TEST_COMPANY_ID,
        email: EMAILS.hr,
        passwordHash,
        fullName: 'Kofi HR',
        role: 'HR_PAYROLL',
      },
      {
        companyId: TEST_COMPANY_ID,
        email: EMAILS.supervisor,
        passwordHash,
        fullName: 'Yaw Supervisor',
        role: 'SUPERVISOR',
        employeeId: SUPERVISOR_EMPLOYEE_ID,
      },
      {
        companyId: TEST_COMPANY_ID,
        email: EMAILS.guard,
        passwordHash,
        fullName: 'Kwame Guard',
        role: 'GUARD',
        employeeId: GUARD_EMPLOYEE_ID,
      },
    ],
  });
}

function site(id: string, code: string, name: string) {
  return {
    id,
    companyId: TEST_COMPANY_ID,
    code,
    name,
    clientName: 'Test Client Ltd',
    region: 'GREATER_ACCRA' as const,
    city: 'Accra',
    status: 'ACTIVE' as const,
  };
}

function employee(
  id: string,
  staffNumber: string,
  firstName: string,
  lastName: string,
  position: string,
  status: 'ACTIVE' | 'TERMINATED',
) {
  const gone = status === 'TERMINATED';
  return {
    id,
    companyId: TEST_COMPANY_ID,
    staffNumber,
    firstName,
    lastName,
    phone: `+23320${staffNumber.slice(4)}0`,
    ghanaCardNumber: `GHA-9${staffNumber.slice(4)}000-1`,
    position,
    status,
    biometricEnrolledAt: gone ? null : new Date('2026-02-01T10:00:00Z'),
    hireDate: new Date('2026-01-05T00:00:00Z'),
    terminationDate: gone ? new Date('2026-08-31T00:00:00Z') : null,
    terminationReason: gone ? ('RESIGNED' as const) : null,
  };
}

function period(employeeId: string) {
  return {
    companyId: TEST_COMPANY_ID,
    employeeId,
    startsOn: new Date('2026-01-05T00:00:00Z'),
    endsOn: null,
  };
}

function assignment(employeeId: string, siteId: string) {
  return {
    companyId: TEST_COMPANY_ID,
    employeeId,
    siteId,
    startsOn: new Date('2026-01-05T00:00:00Z'),
    endsOn: null,
  };
}
