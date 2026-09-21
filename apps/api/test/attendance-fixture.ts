import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { type SignedRoute, signRequest } from '../src/modules/attendance/device-signature.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';
import { hashPassword, TEST_ONLY_SCRYPT_PARAMS } from '../src/modules/identity/password.js';

/**
 * A brand-new fictional company for each attendance test run. Punches are
 * append-only — they can never be deleted — so these tests cannot reset a
 * shared company the way `db-fixture.ts` does. Every run gets fresh IDs, and
 * old runs simply stay behind in the scratch database.
 */
export interface AttendanceCompany {
  companyId: string;
  siteA: string;
  siteB: string;
  /** An ACTIVE guard (posted to site A), a SUSPENDED one and one who left on `leaverLastDay`. */
  active: { id: string; staffNumber: string };
  suspended: { id: string; staffNumber: string };
  leaver: { id: string; staffNumber: string };
  leaverLastDay: string;
  adminUserId: string;
  hrUserId: string;
  /** A GUARD account linked to the ACTIVE employee. */
  guardUserId: string;
  supervisorUserId: string;
  /** The supervisor is an employee too, posted to site A. */
  supervisorEmployeeId: string;
}

export async function createAttendanceCompany(prisma: PrismaClient): Promise<AttendanceCompany> {
  const companyId = randomUUID();
  const run = companyId.slice(0, 8);
  await prisma.company.create({ data: { id: companyId, name: `Attendance Test ${run}` } });

  const site = (code: string) =>
    prisma.site.create({
      data: {
        companyId,
        code,
        name: `Test site ${code}`,
        clientName: 'Test Client Ltd',
        region: 'GREATER_ACCRA',
        city: 'Accra',
      },
    });
  const [siteA, siteB] = await Promise.all([site('ATA-01'), site('ATB-01')]);

  // Staff numbers are unique per company, so the same numbers are fine in every run.
  const employee = (
    staffNumber: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED',
    index: number,
  ) =>
    prisma.employee.create({
      data: {
        companyId,
        staffNumber,
        firstName: 'Test',
        lastName: `Person ${index}`,
        phone: `+23320999${String(index).padStart(4, '0')}`,
        ghanaCardNumber: `GHA-8${String(index).padStart(8, '0')}-${index % 10}`,
        position: 'Security Guard',
        status,
        hireDate: new Date('2026-01-05T00:00:00Z'),
        terminationDate: status === 'TERMINATED' ? new Date('2026-09-10T00:00:00Z') : null,
        terminationReason: status === 'TERMINATED' ? 'RESIGNED' : null,
      },
    });
  const active = await employee('SMT-70001', 'ACTIVE', 1);
  const suspended = await employee('SMT-70002', 'SUSPENDED', 2);
  const leaver = await employee('SMT-70003', 'TERMINATED', 3);
  const supervisor = await employee('SMT-70004', 'ACTIVE', 4);
  // The supervisor and the active guard are both posted to site A.
  await prisma.siteAssignment.createMany({
    data: [supervisor, active].map((person) => ({
      companyId,
      employeeId: person.id,
      siteId: siteA.id,
      startsOn: new Date('2026-01-05T00:00:00Z'),
    })),
  });

  const passwordHash = await hashPassword('demo-password', TEST_ONLY_SCRYPT_PARAMS);
  const admin = await prisma.user.create({
    data: {
      companyId,
      email: `admin-${run}@attendance.example`,
      passwordHash,
      fullName: 'Test Admin',
      role: 'ADMIN',
      // A usable admin must have two-factor switched on (the token guard checks).
      twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const hr = await prisma.user.create({
    data: {
      companyId,
      email: `hr-${run}@attendance.example`,
      passwordHash,
      fullName: 'Test HR',
      role: 'HR_PAYROLL',
      twoFactorEnabledAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const guard = await prisma.user.create({
    data: {
      companyId,
      email: `guard-${run}@attendance.example`,
      passwordHash,
      fullName: 'Test Guard',
      role: 'GUARD',
      employeeId: active.id,
    },
  });
  const supervisorUser = await prisma.user.create({
    data: {
      companyId,
      email: `supervisor-${run}@attendance.example`,
      passwordHash,
      fullName: 'Test Supervisor',
      role: 'SUPERVISOR',
      employeeId: supervisor.id,
    },
  });

  return {
    companyId,
    siteA: siteA.id,
    siteB: siteB.id,
    active: { id: active.id, staffNumber: active.staffNumber },
    suspended: { id: suspended.id, staffNumber: suspended.staffNumber },
    leaver: { id: leaver.id, staffNumber: leaver.staffNumber },
    leaverLastDay: '2026-09-10',
    adminUserId: admin.id,
    hrUserId: hr.id,
    guardUserId: guard.id,
    supervisorUserId: supervisorUser.id,
    supervisorEmployeeId: supervisor.id,
  };
}

/** A registered device and its one-time secret. */
export interface TestDevice {
  id: string;
  secret: string;
}

/** Sends a request exactly as a device does: serialise once, sign that text, send it. */
export function signedPost(
  app: NestExpressApplication,
  route: SignedRoute,
  body: unknown,
  device: TestDevice,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const text = JSON.stringify(body);
  return request(app.getHttpServer())
    .post(`/api/v1/${route}`)
    .set('Content-Type', 'application/json')
    .set('X-Samtec-Device', device.id)
    .set('X-Samtec-Timestamp', timestamp)
    .set('X-Samtec-Signature', signRequest(device.secret, timestamp, route, text))
    .send(text);
}

/** Registers a device through the API, as an administrator would. */
export async function registerDevice(
  app: NestExpressApplication,
  adminToken: string,
  siteId: string,
  name: string,
): Promise<TestDevice> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, siteId, kind: 'MOCK' })
    .expect(201);
  return { id: response.body.device.id, secret: response.body.secret };
}

/** Access tokens for each of the company's accounts, as if they had signed in. */
export async function tokensFor(app: NestExpressApplication, company: AttendanceCompany) {
  const tokens = app.get(TokensService);
  const sign = (userId: string, role: 'ADMIN' | 'HR_PAYROLL' | 'SUPERVISOR' | 'GUARD', employeeId: string | null) =>
    tokens.signAccessToken({ userId, companyId: company.companyId, role, employeeId });
  return {
    admin: await sign(company.adminUserId, 'ADMIN', null),
    hr: await sign(company.hrUserId, 'HR_PAYROLL', null),
    supervisor: await sign(company.supervisorUserId, 'SUPERVISOR', company.supervisorEmployeeId),
    guard: await sign(company.guardUserId, 'GUARD', company.active.id),
  };
}
