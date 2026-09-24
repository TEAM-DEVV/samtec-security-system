/**
 * Fills the database with a fictional demo company for development and demos.
 * Run it with `pnpm db:seed`. Running it again is safe: existing rows are
 * updated instead of duplicated.
 *
 * Every person, phone number, Ghana Card number and company here is made up.
 * Never put real personal data in seed files (see SECURITY.md).
 *
 * On this computer it also registers one MOCK clock-in device per site, for the Phase 2 demo
 * (`pnpm --filter @samtec/api mock:devices`, docs/guides/10-attendance-demo.md).
 *
 * It only writes to a database on this computer. To fill a hosted demo
 * database on purpose, run it with ALLOW_REMOTE_SEED=yes.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { DEMO_DEVICES, demoDeviceSecret } from '../scripts/demo-devices.js';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { isOnThisComputer } from '../src/config/local-database.js';
import { PrismaClient, type Site } from '../src/generated/prisma/client.js';
import {
  EmployeeStatus,
  GhanaRegion,
  SiteStatus,
  TerminationReason,
  UserRole,
} from '../src/generated/prisma/enums.js';
import { deviceSecretKey } from '../src/modules/attendance/device-secret.js';
import { hashPassword } from '../src/modules/identity/password.js';
import { sealSecret } from '../src/modules/identity/secret-box.js';

/** The planted ghost of rule R5, so a test can name him without guessing. */
export const PLANTED_GHOST_STAFF_NUMBER = 'SMT-00099';

const DEMO_COMPANY_ID = '01927c3e-0000-7000-8000-000000000001';
const EMPLOYEE_COUNT = 50;

const SITES = [
  {
    code: 'ACC-01',
    name: 'Ridge Towers Office Complex',
    clientName: 'Ridge Towers Management Ltd',
    region: GhanaRegion.GREATER_ACCRA,
    city: 'Accra',
  },
  {
    code: 'ACC-02',
    name: 'East Legon Residences',
    clientName: 'Palmview Estates Ltd',
    region: GhanaRegion.GREATER_ACCRA,
    city: 'Accra',
  },
  {
    code: 'TEM-01',
    name: 'Harbour Road Warehouse 7',
    clientName: 'Coastline Logistics Ltd',
    region: GhanaRegion.GREATER_ACCRA,
    city: 'Tema',
  },
  {
    code: 'KSI-01',
    name: 'Adum Retail Centre',
    clientName: 'Asante Retail Holdings',
    region: GhanaRegion.ASHANTI,
    city: 'Kumasi',
  },
  {
    code: 'TKD-01',
    name: 'Takoradi Port Depot',
    clientName: 'Western Gateway Shipping Ltd',
    region: GhanaRegion.WESTERN,
    city: 'Sekondi-Takoradi',
  },
];

const FIRST_NAMES = [
  'Kwame',
  'Kofi',
  'Kwabena',
  'Kwaku',
  'Yaw',
  'Kwasi',
  'Kojo',
  'Ama',
  'Abena',
  'Akua',
  'Yaa',
  'Afua',
  'Adjoa',
  'Esi',
  'Efua',
  'Emmanuel',
  'Isaac',
  'Daniel',
  'Joseph',
  'Grace',
  'Mercy',
  'Comfort',
  'Patience',
  'Ibrahim',
  'Abdul',
  'Fatima',
  'Selorm',
  'Delali',
  'Mawuli',
  'Eyram',
];

const LAST_NAMES = [
  'Mensah',
  'Owusu',
  'Boateng',
  'Asante',
  'Osei',
  'Appiah',
  'Addo',
  'Agyeman',
  'Amoah',
  'Darko',
  'Frimpong',
  'Gyamfi',
  'Kyei',
  'Ofori',
  'Quaye',
  'Tetteh',
  'Adjei',
  'Ansah',
  'Bonsu',
  'Nkansah',
  'Sarpong',
  'Acheampong',
  'Opoku',
  'Wiredu',
  'Amankwah',
  'Lartey',
  'Abubakar',
  'Iddrisu',
  'Agbeko',
  'Dzamesi',
];

// Repeated entries make some positions more common, like in a real guard force.
const POSITIONS = [
  'Security Guard',
  'Security Guard',
  'Security Guard',
  'Security Guard',
  'Security Guard',
  'Security Guard',
  'Senior Guard',
  'Senior Guard',
  'Site Supervisor',
  'Patrol Officer',
];

loadEnvFile();
const env = parseEnv(process.env);
const databaseUrl = env.DATABASE_URL;
refuseRemoteDatabase(databaseUrl);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

try {
  await main();
} finally {
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  const random = createRandom(20_260_915);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new Error('Cannot pick from an empty list');
    }
    return item;
  };

  const company = await prisma.company.upsert({
    where: { id: DEMO_COMPANY_ID },
    update: {},
    create: { id: DEMO_COMPANY_ID, name: 'Demo Security Company Ltd' },
  });

  const sites: Site[] = [];
  for (const site of SITES) {
    sites.push(
      await prisma.site.upsert({
        where: { companyId_code: { companyId: company.id, code: site.code } },
        update: {
          name: site.name,
          clientName: site.clientName,
          region: site.region,
          city: site.city,
        },
        create: { ...site, companyId: company.id, status: SiteStatus.ACTIVE },
      }),
    );
  }

  for (let index = 0; index < EMPLOYEE_COUNT; index += 1) {
    const number = index + 1;
    const staffNumber = `SMT-${String(number).padStart(5, '0')}`;
    const status = statusFor(index);
    const isNewStarter = status === EmployeeStatus.PENDING_ENROLLMENT;
    const hasLeft = status === EmployeeStatus.TERMINATED;
    const hireDate = isNewStarter
      ? randomDate(random, '2026-08-17', '2026-09-11')
      : randomDate(random, '2019-01-07', '2026-06-29');
    const terminationDate = hasLeft ? new Date('2026-07-31T00:00:00Z') : null;

    const details = {
      firstName: pick(FIRST_NAMES),
      lastName: pick(LAST_NAMES),
      otherNames: random() < 0.3 ? pick(FIRST_NAMES) : null,
      // Obviously fake numbers that still match the real formats.
      phone: `+233200000${String(number).padStart(3, '0')}`,
      ghanaCardNumber: `GHA-000000${String(number).padStart(3, '0')}-${number % 10}`,
      position: pick(POSITIONS),
      status,
      // Everyone except new starters enrolled their biometrics the day after
      // being hired, at 10:00 UTC (hire date + 34 hours).
      biometricEnrolledAt: isNewStarter ? null : new Date(hireDate.getTime() + 34 * 3_600_000),
      hireDate,
      terminationDate,
      terminationReason: hasLeft ? TerminationReason.RESIGNED : null,
    };

    const employee = await prisma.employee.upsert({
      where: { companyId_staffNumber: { companyId: company.id, staffNumber } },
      update: details,
      create: { ...details, companyId: company.id, staffNumber },
    });

    // Each seeded employee has exactly one employment period so far: open for
    // everyone still here, closed on the termination date for those who left.
    const periodCount = await prisma.employmentPeriod.count({
      where: { employeeId: employee.id },
    });
    if (periodCount === 0) {
      await prisma.employmentPeriod.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          startsOn: hireDate,
          endsOn: terminationDate,
          terminationReason: details.terminationReason,
        },
      });
    }

    // Pick the site first so the random sequence is identical on every run.
    const site = pick(sites);
    // Half of the new starters are not posted to a site yet.
    const needsSite = !isNewStarter || index % 2 === 0;
    const assignmentCount = await prisma.siteAssignment.count({
      where: { employeeId: employee.id },
    });
    if (needsSite && assignmentCount === 0) {
      await prisma.siteAssignment.create({
        data: {
          companyId: company.id,
          employeeId: employee.id,
          siteId: site.id,
          startsOn: hireDate,
          endsOn: terminationDate,
        },
      });
    }
  }

  await seedRosters(company.id, sites);
  await assignShifts(company.id);
  if (isOnThisComputer(databaseUrl)) {
    await seedDevices(company.id, sites);
  } else {
    console.log(
      'Skipped the demo devices: their secrets come from AUTH_SECRET, so they only belong on this computer. Register MOCK devices on the Devices page instead.',
    );
  }
  await seedUsers(company.id);
  // After the planted ghost, so that they are on the payroll like everybody
  // else: a ghost with no pay terms would be left off a run and the Phase 5
  // demo would have nothing to catch.
  await seedPlantedGhost(company.id, sites);
  await seedPayroll(company.id);

  const taxTableCount = await prisma.taxTable.count({ where: { companyId: company.id } });
  const payTermsCount = await prisma.employeePayTerms.count({ where: { companyId: company.id } });
  const employeeCount = await prisma.employee.count({ where: { companyId: company.id } });
  const userCount = await prisma.user.count({ where: { companyId: company.id } });
  console.log(
    `Seeded "${company.name}": ${sites.length} sites, ${employeeCount} employees, ${await prisma.device.count({ where: { companyId: company.id } })} devices, ${userCount} sign-in accounts, ${taxTableCount} tax table version and ${payTermsCount} pay terms rows (all fictional).`,
  );
}

/**
 * What payroll needs before a month can be calculated: the statutory rates,
 * what each person is paid, and where the money is sent.
 *
 * The 2026 PAYE bands and SSNIT percentages are the ones written up in
 * docs/plan/09-payroll-engine-ghana.md. **They came from online calculators
 * and guides during planning and must be checked against the official GRA and
 * SSNIT publications before a client pilot** — which is exactly why they live
 * in a versioned table with their source recorded, and not in the code.
 *
 * It uses no random numbers, so the 50 employees above are unchanged, and it
 * is safe to run twice.
 */
async function seedPayroll(companyId: string): Promise<void> {
  // An administrator sets the rates and the pay up, so the rows say who did.
  const admin = await prisma.user.findFirst({
    where: { companyId, role: 'ADMIN' },
    orderBy: { email: 'asc' },
  });
  if (!admin) {
    throw new Error('Seed the sign-in accounts before the payroll rows.');
  }
  const byUserId = admin.id;
  const taxYear = 2026;
  const existing = await prisma.taxTable.findFirst({ where: { companyId, taxYear } });
  if (!existing) {
    await prisma.taxTable.create({
      data: {
        companyId,
        taxYear,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        // Basis points: 550 is 5.5%. The employee's share is the only one ever
        // deducted from a worker; the employer's 13% is a company cost, and
        // Tier 1 and Tier 2 are both shares of basic, not slices of the 13%.
        ssnitEmployeeBasisPoints: 550,
        ssnitEmployerBasisPoints: 1300,
        ssnitTier1BasisPoints: 1350,
        ssnitTier2BasisPoints: 500,
        sourceName: 'GRA PAYE rates 2026 (to be verified before the pilot)',
        sourceUrl: 'https://gra.gov.gh/domestic-tax/tax-types/paye/',
        sourceCheckedOn: new Date('2026-01-05T00:00:00Z'),
        createdByUserId: byUserId,
        bands: {
          // Widths are pesewas: the tax-free GHS 490 is 49000. The last band
          // has no width because it has no upper limit.
          create: [
            { companyId, ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
            { companyId, ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
            { companyId, ordinal: 3, widthPesewas: 50_000, rateBasisPoints: 1000 },
            { companyId, ordinal: 4, widthPesewas: 200_000, rateBasisPoints: 1750 },
            { companyId, ordinal: 5, widthPesewas: 200_000, rateBasisPoints: 2500 },
            { companyId, ordinal: 6, widthPesewas: 1_491_000, rateBasisPoints: 3000 },
            { companyId, ordinal: 7, widthPesewas: null, rateBasisPoints: 3500 },
          ],
        },
      },
    });
  }

  // What each job pays a month, in pesewas. Fictional but realistic for a
  // Ghanaian security firm, and spread across the tax bands on purpose so a
  // demo run shows more than one rate.
  const basicByPosition: Record<string, number> = {
    'Security Guard': 120_000,
    'Senior Security Guard': 150_000,
    'Site Supervisor': 220_000,
    'Control Room Operator': 180_000,
    'Operations Manager': 450_000,
  };

  const employees = await prisma.employee.findMany({
    where: { companyId },
    orderBy: { staffNumber: 'asc' },
    select: { id: true, staffNumber: true, position: true, hireDate: true },
  });

  for (const [index, employee] of employees.entries()) {
    const effectiveFrom =
      employee.hireDate > new Date('2026-01-01T00:00:00Z')
        ? employee.hireDate
        : new Date('2026-01-01T00:00:00Z');
    const alreadySet = await prisma.employeePayTerms.findFirst({
      where: { employeeId: employee.id },
    });
    if (!alreadySet) {
      await prisma.employeePayTerms.create({
        data: {
          companyId,
          employeeId: employee.id,
          effectiveFrom,
          basicMonthlyPesewas: basicByPosition[employee.position] ?? 120_000,
          overtimeHourlyPesewas: 900,
          // Every third person has a transport allowance, every fourth a
          // non-taxable one, every fifth a uniform instalment.
          taxableAllowancePesewas: index % 3 === 0 ? 15_000 : 0,
          nonTaxableAllowancePesewas: index % 4 === 0 ? 5_000 : 0,
          otherDeductionPesewas: index % 5 === 0 ? 2_000 : 0,
          createdByUserId: byUserId,
        },
      });
    }

    // Two people in every fifteen have no payment details, so the bank file
    // shows a payroll officer who still has to be chased.
    if (index % 15 < 13) {
      const onFile = await prisma.employeePaymentDetails.findUnique({
        where: { employeeId: employee.id },
      });
      if (!onFile) {
        const byMomo = index % 3 === 2;
        await prisma.employeePaymentDetails.create({
          data: {
            companyId,
            employeeId: employee.id,
            bankName: byMomo ? null : 'Akwaaba Bank',
            accountName: byMomo ? null : `Account of ${employee.staffNumber}`,
            accountNumber: byMomo ? null : `10${String(index + 1).padStart(11, '0')}`,
            momoNumber: byMomo ? `+2332400000${String(index % 100).padStart(2, '0')}` : null,
            updatedByUserId: byUserId,
          },
        });
      }
    }
  }
}

/**
 * The planted ghost the Phase 5 demo has to catch: on the payroll, posted to
 * a site, past the settling-in period, and never once at a gate
 * (docs/plan/08-ghost-detection-engine.md, rule R5).
 *
 * It is labelled ground truth — the report's precision and recall discussion
 * is written from finding exactly this person and nobody else. Fictional,
 * like every other row here, and deliberately unremarkable: a ghost that
 * looked odd in the list would prove nothing.
 *
 * It uses no random numbers, so the 50 employees above are unchanged.
 */
async function seedPlantedGhost(companyId: string, sites: Site[]): Promise<void> {
  const site = sites[0];
  if (!site) {
    return;
  }
  const hireDate = new Date(Date.now() - 45 * 86_400_000);
  const details = {
    firstName: 'Yaw',
    lastName: 'Boadu',
    otherNames: null,
    phone: '+233200000199',
    email: null,
    ghanaCardNumber: 'GHA-999000199-9',
    position: 'Security Guard',
    status: EmployeeStatus.ACTIVE,
    // Enrolled on paper, so the only thing wrong is that nobody has ever
    // seen him at a gate.
    biometricEnrolledAt: new Date(hireDate.getTime() + 34 * 3_600_000),
    hireDate,
    terminationDate: null,
    terminationReason: null,
  };
  const ghost = await prisma.employee.upsert({
    where: { companyId_staffNumber: { companyId, staffNumber: PLANTED_GHOST_STAFF_NUMBER } },
    update: details,
    create: { ...details, companyId, staffNumber: PLANTED_GHOST_STAFF_NUMBER },
  });

  const periods = await prisma.employmentPeriod.count({ where: { employeeId: ghost.id } });
  if (periods === 0) {
    await prisma.employmentPeriod.create({
      data: { companyId, employeeId: ghost.id, startsOn: hireDate, endsOn: null },
    });
  }
  const postings = await prisma.siteAssignment.count({ where: { employeeId: ghost.id } });
  if (postings === 0) {
    await prisma.siteAssignment.create({
      data: { companyId, employeeId: ghost.id, siteId: site.id, startsOn: hireDate },
    });
  }
}

/**
 * Two posts per site and the two classic 12-hour shift patterns, so the
 * rosters part of the dashboard has something to show.
 */
async function seedRosters(companyId: string, sites: Site[]): Promise<void> {
  for (const site of sites) {
    for (const post of [
      { name: 'Main Gate', requiredGuards: 2 },
      { name: 'Reception', requiredGuards: 1 },
    ]) {
      await prisma.post.upsert({
        where: { siteId_name: { siteId: site.id, name: post.name } },
        update: { requiredGuards: post.requiredGuards },
        create: { ...post, companyId, siteId: site.id },
      });
    }
  }

  for (const pattern of [
    { name: 'Day Shift', startMinutes: 6 * 60, endMinutes: 18 * 60 },
    // Crosses midnight: starts one evening and ends the next morning.
    { name: 'Night Shift', startMinutes: 18 * 60, endMinutes: 6 * 60 },
    // Eight hours across midnight: the 480-minute night shift of the Phase 2 demo.
    { name: 'Night Watch', startMinutes: 22 * 60, endMinutes: 6 * 60 },
  ]) {
    await prisma.shiftPattern.upsert({
      where: { companyId_name: { companyId, name: pattern.name } },
      update: { startMinutes: pattern.startMinutes, endMinutes: pattern.endMinutes },
      create: { ...pattern, companyId },
    });
  }
}

/**
 * Gives every current posting that has none yet a post (Main Gate) and a
 * shift pattern: every fourth guard works Night Watch (22:00–06:00), the rest
 * Day Shift. The demo devices punch according to these. Postings someone
 * already changed are left alone.
 */
async function assignShifts(companyId: string): Promise<void> {
  const patterns = await prisma.shiftPattern.findMany({ where: { companyId } });
  const day = patterns.find((pattern) => pattern.name === 'Day Shift');
  const nightWatch = patterns.find((pattern) => pattern.name === 'Night Watch');
  if (!day || !nightWatch) {
    throw new Error('The Day Shift and Night Watch patterns are missing.');
  }
  const mainGates = new Map(
    (await prisma.post.findMany({ where: { companyId, name: 'Main Gate' } })).map((post) => [
      post.siteId,
      post.id,
    ]),
  );
  const postings = await prisma.siteAssignment.findMany({
    where: { companyId, endsOn: null, shiftPatternId: null },
    include: { employee: { select: { staffNumber: true } } },
    orderBy: { employee: { staffNumber: 'asc' } },
  });
  for (const [index, posting] of postings.entries()) {
    await prisma.siteAssignment.update({
      where: { id: posting.id },
      data: {
        postId: posting.postId ?? mainGates.get(posting.siteId) ?? null,
        shiftPatternId: index % 4 === 3 ? nightWatch.id : day.id,
      },
    });
  }
}

/**
 * One MOCK clock-in device per site, on this computer only. Each secret is
 * derived from AUTH_SECRET (see scripts/demo-devices.ts), so the demo
 * simulator on this computer can sign with it, while the database only ever
 * holds it encrypted. It never takes over a device someone else registered.
 */
async function seedDevices(companyId: string, sites: Site[]): Promise<void> {
  const key = deviceSecretKey(env.AUTH_SECRET);
  for (const demo of DEMO_DEVICES) {
    const site = sites.find((candidate) => candidate.code === demo.siteCode);
    if (!site) {
      throw new Error(`Site ${demo.siteCode} is missing, so its demo device cannot be registered.`);
    }
    const existing = await prisma.device.findUnique({
      where: { companyId_name: { companyId, name: demo.name } },
    });
    if (existing && (existing.kind !== 'MOCK' || existing.siteId !== site.id)) {
      throw new Error(
        `A device called "${demo.name}" already exists and is not the seed's demo device. Rename it, or run the seed on a fresh database.`,
      );
    }
    const secretEncrypted = sealSecret(demoDeviceSecret(env.AUTH_SECRET, demo.name), key);
    await prisma.device.upsert({
      where: { companyId_name: { companyId, name: demo.name } },
      // Re-sealed on every run, so a changed AUTH_SECRET still leaves working demo devices.
      update: { secretEncrypted, status: 'ACTIVE' },
      create: { companyId, siteId: site.id, name: demo.name, kind: 'MOCK', secretEncrypted },
    });
  }
}

/**
 * Four sign-in accounts for local development, one per kind of first
 * sign-in. Every password is `demo-password` — fine here, because the seed
 * only ever runs against a database on this computer.
 *
 * - supervisor@samtec.example signs straight in.
 * - admin@, admin2@ and hr@ must set up two-factor authentication on first
 *   sign-in, with any authenticator app (the codes really work).
 *
 * There are **two** ADMIN accounts on purpose: biometrics are built so that
 * nobody decides on their own action, so a duplicate-enrollment review and an
 * exemption both need a second ADMIN (docs/plan/13-biometrics-design.md §2).
 */
async function seedUsers(companyId: string): Promise<void> {
  // Hash once and share it: scrypt is deliberately slow.
  const passwordHash = await hashPassword('demo-password');

  // The supervisor account belongs to employee SMT-00003, so site scoping is
  // demonstrable: they only see employees on their own site.
  const supervisorEmployee = await prisma.employee.findUnique({
    where: { companyId_staffNumber: { companyId, staffNumber: 'SMT-00003' } },
  });
  // A SUPERVISOR account must be linked to an employee (a database CHECK).
  if (!supervisorEmployee) {
    throw new Error('Employee SMT-00003 is missing, so the supervisor account cannot be linked.');
  }

  const accounts = [
    {
      email: 'admin@samtec.example',
      fullName: 'Efua Mensah',
      role: UserRole.ADMIN,
      employeeId: null,
    },
    {
      email: 'admin2@samtec.example',
      fullName: 'Abena Owusu',
      role: UserRole.ADMIN,
      employeeId: null,
    },
    {
      email: 'hr@samtec.example',
      fullName: 'Kofi Asante',
      role: UserRole.HR_PAYROLL,
      employeeId: null,
    },
    {
      email: 'supervisor@samtec.example',
      fullName: 'Yaw Boateng',
      role: UserRole.SUPERVISOR,
      employeeId: supervisorEmployee.id,
    },
  ];

  for (const account of accounts) {
    await prisma.user.upsert({
      where: { companyId_email: { companyId, email: account.email } },
      update: { fullName: account.fullName, role: account.role, employeeId: account.employeeId },
      create: { ...account, companyId, passwordHash },
    });
  }
}

/**
 * Demo data belongs on a developer's own computer. Refuse to write it anywhere
 * else, such as a shared or hosted database, unless ALLOW_REMOTE_SEED=yes is
 * set on purpose (for example to fill the online demo in Phase 8).
 */
function refuseRemoteDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!isOnThisComputer(url) && process.env.ALLOW_REMOTE_SEED !== 'yes') {
    throw new Error(
      `Refusing to seed the database at "${host}" because it is not on this computer. ` +
        'To fill a hosted demo database on purpose, run the command again with ALLOW_REMOTE_SEED=yes.',
    );
  }
}

/** 40 active, 6 waiting for biometric enrollment, 2 suspended and 2 who have left. */
function statusFor(index: number): EmployeeStatus {
  if (index < 40) return EmployeeStatus.ACTIVE;
  if (index < 46) return EmployeeStatus.PENDING_ENROLLMENT;
  if (index < 48) return EmployeeStatus.SUSPENDED;
  return EmployeeStatus.TERMINATED;
}

/** A small seeded random number generator, so the demo data is the same on every machine. */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A random calendar date between two dates, inclusive, at midnight UTC. */
function randomDate(random: () => number, fromIsoDate: string, toIsoDate: string): Date {
  const dayInMilliseconds = 86_400_000;
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate}T00:00:00Z`);
  const days = Math.round((to - from) / dayInMilliseconds);
  return new Date(from + Math.floor(random() * (days + 1)) * dayInMilliseconds);
}
