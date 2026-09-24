/**
 * Take a backup of a SAMTEC database, or put one back (Phase 7; the drill is
 * written up in docs/guides/11-backup-and-restore.md).
 *
 * **Why this exists.** The hosted database is on Supabase's free plan, which
 * takes no backups at all — no daily copy, no point-in-time recovery. Both
 * are paid features. Until somebody pays for them, this script *is* the
 * backup, and it needs nothing installed: no `pg_dump`, no PostgreSQL client
 * tools, just this repository.
 *
 *   pnpm --filter @samtec/api db:backup
 *   pnpm --filter @samtec/api db:backup -- --to "C:/backups/samtec.ndjson"
 *   pnpm --filter @samtec/api db:restore -- --from "C:/backups/samtec.ndjson"
 *
 * Point it at another database with `DATABASE_URL`, exactly like the rest of
 * the tooling.
 *
 * **A backup file is the whole company in one file**: names, Ghana Card
 * numbers, pay, and the encrypted biometric templates. Keep it where you
 * would keep payslips. It is never written inside this repository, and the
 * script refuses to.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

/** How long the restore's single transaction may take, in milliseconds. */
const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;

/** Rows written in one statement. Small enough for a modest database server. */
const CHUNK = 500;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    to: { type: 'string' },
    from: { type: 'string' },
    restore: { type: 'boolean', default: false },
  },
});

loadEnvFile();
const env = parseEnv(process.env);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

try {
  if (values.restore || values.from) {
    await restore(values.from);
  } else {
    await backup(values.to);
  }
} finally {
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------

/** Every table in the schema, in the order it is declared. */
function tables(): { model: string; property: string }[] {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const names = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1] as string);
  if (names.length === 0) {
    throw new Error('Found no tables in schema.prisma.');
  }
  return names.map((model) => ({
    model,
    property: model.charAt(0).toLowerCase() + model.slice(1),
  }));
}

async function backup(to: string | undefined): Promise<void> {
  const path = to ? resolve(to) : defaultPath();
  refuseInsideTheRepository(path);
  mkdirSync(dirname(path), { recursive: true });

  const file = createWriteStream(path, { encoding: 'utf8' });
  const write = (line: string) =>
    new Promise<void>((done, failed) => {
      file.write(`${line}\n`, (error) => (error ? failed(error) : done()));
    });

  const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 1`;
  await write(
    JSON.stringify({
      samtecBackup: 1,
      takenAt: new Date().toISOString(),
      // Which migration the database was on. A restore into a database on a
      // different migration is refused: the columns would not line up.
      migration: applied[0]?.migration_name ?? null,
    }),
  );

  let total = 0;
  for (const { model, property } of tables()) {
    const table = (
      prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<unknown[]> }>
    )[property];
    if (!table) {
      throw new Error(`The generated client has no ${property}. Run prisma generate.`);
    }
    const rows: unknown[] = await table.findMany({});
    for (const row of rows) {
      await write(JSON.stringify({ model, row }, keepTypes));
    }
    total += rows.length;
    if (rows.length > 0) {
      console.log(`  ${model}: ${rows.length}`);
    }
  }
  await new Promise((done) => file.end(done));
  console.log(`\nBacked up ${total} rows to ${path}`);
  console.log('It holds personal data. Keep it where you would keep payslips.');
}

async function restore(from: string | undefined): Promise<void> {
  if (!from) {
    throw new Error('Pass --from with the backup file to put back.');
  }
  const path = resolve(from);
  if (!existsSync(path)) {
    throw new Error(`No such file: ${path}`);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] ?? '{}') as { samtecBackup?: number; migration?: string };
  if (header.samtecBackup !== 1) {
    throw new Error('That file is not a SAMTEC backup.');
  }
  const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 1`;
  const here = applied[0]?.migration_name ?? null;
  if (header.migration && here !== header.migration) {
    throw new Error(
      `The backup was taken on migration ${header.migration}, but this database is on ${here ?? 'none'}. Bring the database to that migration first.`,
    );
  }

  // Everything, in one go, on one connection. `session_replication_role`
  // turns off triggers and foreign keys for this connection only — a restore
  // puts rows back exactly as they were, and the rules that refuse an edit or
  // a delete would otherwise refuse the rows they themselves produced.
  const byModel = new Map<string, unknown[]>();
  for (const line of lines.slice(1)) {
    const { model, row } = JSON.parse(line, restoreTypes) as { model: string; row: unknown };
    byModel.set(model, [...(byModel.get(model) ?? []), row]);
  }

  let total = 0;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const { model, property } of tables()) {
        const rows = byModel.get(model) ?? [];
        if (rows.length === 0) {
          continue;
        }
        const table = (
          tx as unknown as Record<
            string,
            { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> }
          >
        )[property];
        if (!table) {
          throw new Error(`The generated client has no ${property}. Run prisma generate.`);
        }
        for (let start = 0; start < rows.length; start += CHUNK) {
          await table.createMany({ data: rows.slice(start, start + CHUNK) });
        }
        total += rows.length;
        console.log(`  ${model}: ${rows.length}`);
      }
    },
    { timeout: RESTORE_TIMEOUT_MS, maxWait: 30_000 },
  );
  console.log(`\nPut back ${total} rows from ${path}`);
}

/** Types JSON has no word for. Tagged going out, rebuilt coming back. */
function keepTypes(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  return value;
}

function restoreTypes(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const tagged = value as { $bigint?: string; $bytes?: string };
    if (typeof tagged.$bigint === 'string') {
      return BigInt(tagged.$bigint);
    }
    if (typeof tagged.$bytes === 'string') {
      return Buffer.from(tagged.$bytes, 'base64');
    }
  }
  // A date reaches Prisma as its ISO string, which it accepts.
  return value;
}

function defaultPath(): string {
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  return resolve(homedir(), 'samtec-backups', `samtec-${stamp}.ndjson`);
}

/**
 * A backup holds everybody's personal data, so it never goes where code goes:
 * one `git add .` and it would be published for ever.
 */
function refuseInsideTheRepository(path: string): void {
  const repository = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..');
  if (path.replaceAll('\\', '/').startsWith(repository.replaceAll('\\', '/'))) {
    throw new Error(
      `Refusing to write a backup inside the repository (${path}). Choose a folder outside it with --to.`,
    );
  }
}
