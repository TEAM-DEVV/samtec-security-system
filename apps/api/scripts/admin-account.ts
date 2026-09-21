/**
 * Creates a company's first ADMIN account, or rescues an ADMIN who can no
 * longer sign in (lost authenticator, forgotten password) when no other
 * administrator can reset them. Everything else happens in the dashboard.
 *
 *   pnpm --filter @samtec/api account:admin -- --email efua@company.example --name "Efua Mensah"
 *
 * It prints a one-time password link token, once. The person opens
 * `<dashboard>/set-password#token=<token>` and chooses their own password;
 * two-factor setup follows at their first sign-in. Nobody else ever sees
 * the password.
 *
 * Only people with direct database access can run this, and every run is
 * recorded in the audit log (`detail.via = SCRIPT`). It refuses any database
 * that is not on this computer unless ALLOW_REMOTE_ADMIN_SCRIPT=yes is set on
 * purpose.
 */
import { parseArgs } from 'node:util';
import { normalizeEmail } from '../src/common/emails.js';
import { AppConfig } from '../src/config/app-config.js';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { isOnThisComputer } from '../src/config/local-database.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { AccountsService } from '../src/modules/identity/accounts.service.js';
import { AuditService } from '../src/modules/identity/audit.service.js';
import { TokensService } from '../src/modules/identity/tokens.service.js';

const { values } = parseArgs({
  // pnpm passes its `--` separator through, which would end the options.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    company: { type: 'string' },
  },
});
if (!values.email) {
  throw new Error('Pass --email (and --name when creating a new administrator).');
}
const email = normalizeEmail(values.email);

loadEnvFile();
const config = new AppConfig(parseEnv(process.env));
refuseRemoteDatabase(config.databaseUrl);
const prisma = new PrismaService(config);
const audit = new AuditService(prisma);
const accounts = new AccountsService(prisma, new TokensService(config), audit);

try {
  const companyId = await chooseCompany(values.company);
  const existing = await prisma.user.findFirst({ where: { companyId, email } });
  if (existing && existing.role !== 'ADMIN') {
    throw new Error(
      `${email} is a ${existing.role} account. This script only handles ADMIN accounts.`,
    );
  }
  if (!existing && !values.name) {
    throw new Error('Pass --name to create a new administrator.');
  }

  const setup = await prisma.$transaction(async (tx) => {
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            passwordHash: null,
            twoFactorSecretEncrypted: null,
            twoFactorEnabledAt: null,
            twoFactorLastUsedStep: null,
          },
        })
      : await tx.user.create({
          data: {
            companyId,
            email,
            fullName: values.name ?? '',
            role: 'ADMIN',
            passwordHash: null,
          },
        });
    await accounts.endAllAccess(user.id, tx);
    const passwordSetup = await accounts.issuePasswordSetup(user.id, tx);
    await audit.record(
      {
        companyId,
        actorUserId: null,
        action: existing ? 'user.sign_in_reset' : 'user.created',
        entityType: 'user',
        entityId: user.id,
        detail: { via: 'SCRIPT', role: 'ADMIN' },
      },
      tx,
    );
    return passwordSetup;
  });

  console.log(existing ? `Sign-in reset for ${email}.` : `Created administrator ${email}.`);
  console.log('Give this one-time link token to the person, in person or by private message.');
  console.log(`It works once, until ${setup.expiresAt}:`);
  console.log(`\n  ${setup.token}\n`);
  console.log(
    'They open <dashboard address>/set-password#token=<the token> and choose their password.',
  );
} finally {
  await prisma.$disconnect();
}

/** The only company, or the one named with --company. */
async function chooseCompany(companyId: string | undefined): Promise<string> {
  if (companyId) {
    await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    return companyId;
  }
  const companies = await prisma.company.findMany({ select: { id: true }, take: 2 });
  if (companies.length !== 1 || !companies[0]) {
    throw new Error('There is not exactly one company. Pass --company <id>.');
  }
  return companies[0].id;
}

function refuseRemoteDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!isOnThisComputer(url) && process.env.ALLOW_REMOTE_ADMIN_SCRIPT !== 'yes') {
    throw new Error(
      `Refusing to change accounts in the database at "${host}". ` +
        'Run the command again with ALLOW_REMOTE_ADMIN_SCRIPT=yes if you really mean to.',
    );
  }
}
