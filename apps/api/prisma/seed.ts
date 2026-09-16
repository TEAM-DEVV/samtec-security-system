/**
 * Fills the database with a fictional demo company for development and demos.
 * Run it with `pnpm db:seed`. Running it again is safe: existing rows are
 * updated instead of duplicated.
 *
 * Every person, phone number, Ghana Card number and company here is made up.
 * Never put real personal data in seed files (see SECURITY.md).
 *
 * It only writes to a database on this computer. To fill a hosted demo
 * database on purpose, run it with ALLOW_REMOTE_SEED=yes.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { PrismaClient, type Site } from '../src/generated/prisma/client.js';
import {
  EmployeeStatus,
  GhanaRegion,
  SiteStatus,
  TerminationReason,
} from '../src/generated/prisma/enums.js';

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
const databaseUrl = parseEnv(process.env).DATABASE_URL;
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

  const employeeCount = await prisma.employee.count({ where: { companyId: company.id } });
  console.log(
    `Seeded "${company.name}": ${sites.length} sites and ${employeeCount} employees (all fictional).`,
  );
}

/**
 * Demo data belongs on a developer's own computer. Refuse to write it anywhere
 * else, such as a shared or hosted database, unless ALLOW_REMOTE_SEED=yes is
 * set on purpose (for example to fill the online demo in Phase 8).
 */
function refuseRemoteDatabase(url: string): void {
  const host = new URL(url).hostname;
  const isOnThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!isOnThisComputer && process.env.ALLOW_REMOTE_SEED !== 'yes') {
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
