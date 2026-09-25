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
 *   pnpm --filter @samtec/api db:backup -- --to "D:/safe/samtec.ndjson"
 *   pnpm --filter @samtec/api db:restore -- --from "D:/safe/samtec.ndjson" --yes
 *
 * Point it at another database with `DATABASE_URL`, exactly like the rest of
 * the tooling.
 *
 * **A backup file is the whole company in one file**: names, Ghana Card
 * numbers, pay, and the encrypted biometric templates. Keep it where you
 * would keep payslips. It is never written inside this repository, and the
 * script refuses to.
 *
 * **It suits a database of this size** — tens of megabytes, which is a
 * company of a few hundred guards with a year of punches. One table at a
 * time is held in memory on the way out, and the whole file on the way back
 * in. A database of many gigabytes wants the hosting platform's own tool
 * instead, and the guide says so rather than leaving it to be discovered.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';

/** How long one transaction — the read side or the write side — may take. */
const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

/** Rows written in one statement. Small enough for a modest database server. */
const CHUNK = 500;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    to: { type: 'string' },
    from: { type: 'string' },
    restore: { type: 'boolean', default: false },
    /** Restoring writes to whatever DATABASE_URL points at. Say so out loud. */
    yes: { type: 'boolean', default: false },
  },
});

// **Which job this is, is never guessed.** `db:backup` and `db:restore` each
// pass their own flag; a stray option can then only be a mistake, and a
// mistake here either writes the wrong file or fills the wrong database.
if (values.restore && values.to !== undefined) {
  throw new Error('--to is for taking a backup. To put one back, use --from.');
}
if (!values.restore && values.from !== undefined) {
  throw new Error('--from is for putting a backup back. Use pnpm db:restore.');
}

loadEnvFile();
const env = parseEnv(process.env);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

try {
  if (values.restore) {
    await restore(values.from, values.yes);
  } else {
    await backup(values.to);
  }
} finally {
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------

/** Every table in the schema, in the order it is declared. */
function tables(): { model: string; property: string; jsonFields: string[] }[] {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const blocks = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  if (blocks.length === 0) {
    throw new Error('Found no tables in schema.prisma.');
  }
  return blocks.map((block) => {
    const model = block[1] as string;
    // Which columns hold JSON. An empty one of those needs care: see
    // `emptyJsonIsNothing` below.
    const jsonFields = [...(block[2] as string).matchAll(/^\s+(\w+)\s+Json\??/gm)].map(
      (field) => field[1] as string,
    );
    return { model, property: model.charAt(0).toLowerCase() + model.slice(1), jsonFields };
  });
}

/**
 * **An empty JSON column is a trap.** PostgreSQL can hold two different
 * empty values there: no value at all (SQL NULL), and the JSON word `null`.
 * Prisma hands both to us as plain `null`, and writing plain `null` back
 * stores the JSON word — so a restore would quietly turn "nothing recorded"
 * into "recorded as nothing" on every audit row with no detail. That is a
 * change to the record, in the one table whose whole job is to be
 * unchanged.
 *
 * So an empty JSON column is written back as SQL NULL, which is what this
 * system always means by it: every audit row is written either with a detail
 * or without one, and nothing anywhere stores the JSON word `null` on
 * purpose. A database that did would come back with SQL NULL instead, and
 * that is written down rather than discovered.
 */
function emptyJsonIsNothing(row: unknown, jsonFields: string[]): unknown {
  if (jsonFields.length === 0 || !row || typeof row !== 'object') {
    return row;
  }
  const copy = { ...(row as Record<string, unknown>) };
  for (const field of jsonFields) {
    if (copy[field] === null) {
      copy[field] = Prisma.DbNull;
    }
  }
  return copy;
}

async function backup(to: string | undefined): Promise<void> {
  const path = to ? resolve(to) : defaultPath();
  refuseInsideTheRepository(path);
  // **Only this account may read it.** The file is the whole company in one
  // place, and the guide says to run this from any computer that can reach
  // the database — which includes shared ones. Windows ignores the mode.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const file = createWriteStream(path, { encoding: 'utf8', mode: 0o600 });
  const write = (line: string) =>
    new Promise<void>((done, failed) => {
      file.write(`${line}\n`, (error) => (error ? failed(error) : done()));
    });

  const counts: Record<string, number> = {};
  let total = 0;

  // **One instant for the whole database.** Reading table by table without
  // this, a row written between two reads lands on one side of a relationship
  // only — a run with no lines, a punch with no device. Restoring turns the
  // rules off, so nothing would catch it: the backup would simply be quietly
  // wrong. `RepeatableRead` gives every read below the same instant.
  await prisma.$transaction(
    async (tx) => {
      const applied = await tx.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`;
      await write(
        JSON.stringify({
          samtecBackup: 1,
          takenAt: new Date().toISOString(),
          // Which migration the database was on. A restore into a database on
          // a different migration is refused: the columns would not line up.
          migration: applied[0]?.migration_name ?? null,
        }),
      );
      for (const { model, property } of tables()) {
        const table = (
          tx as unknown as Record<string, { findMany: (args: unknown) => Promise<unknown[]> }>
        )[property];
        if (!table) {
          throw new Error(`The generated client has no ${property}. Run prisma generate.`);
        }
        const rows: unknown[] = await table.findMany({});
        for (const row of rows) {
          await write(JSON.stringify({ model, row }, keepTypes));
        }
        counts[model] = rows.length;
        total += rows.length;
        if (rows.length > 0) {
          console.log(`  ${model}: ${rows.length}`);
        }
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
  );

  // **The last line says how many there should be.** A backup cut short — a
  // full disk, a lost connection, a closed laptop — is otherwise a perfectly
  // readable file that restores quietly missing whatever came after the cut.
  await write(JSON.stringify({ samtecBackupEnd: 1, rows: total, counts }));
  await new Promise((done) => file.end(done));
  console.log(`\nBacked up ${total} rows to ${path}`);
  console.log('It holds personal data. Keep it where you would keep payslips.');
}

async function restore(from: string | undefined, confirmed: boolean): Promise<void> {
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
  const footer = JSON.parse(lines.at(-1) ?? '{}') as { samtecBackupEnd?: number; rows?: number };
  if (footer.samtecBackupEnd !== 1) {
    throw new Error(
      'That backup has no end marker, so it was cut short. Restoring it would quietly lose whatever is missing.',
    );
  }
  const rows = lines.slice(1, -1);
  if (rows.length !== footer.rows) {
    throw new Error(`That backup says ${footer.rows} rows but holds ${rows.length}.`);
  }

  // **Which database this is about to fill.** Where, never the password.
  const where = describe(env.DATABASE_URL);
  console.log(`About to restore ${rows.length} rows into ${where}.`);
  if (!confirmed) {
    throw new Error(`Restoring writes into ${where}. If that is right, run it again with --yes.`);
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

  // Push onto the list rather than building a new one for every row: a year
  // of punches for a few hundred guards is the size this script is for, and
  // re-spreading the array each time made the restore take minutes of pure
  // copying before it wrote anything — at exactly the moment the database has
  // been lost and this file is all there is.
  const byModel = new Map<string, unknown[]>();
  for (const line of rows) {
    const { model, row } = JSON.parse(line, restoreTypes) as { model: string; row: unknown };
    const waiting = byModel.get(model);
    if (waiting) {
      waiting.push(row);
    } else {
      byModel.set(model, [row]);
    }
  }

  let total = 0;
  await prisma.$transaction(
    async (tx) => {
      // **Only into an empty database.** Restoring on top of rows already
      // there is not a restore: with the rules turned off below, two
      // companies' data can merge without a single complaint.
      for (const { model, property } of tables()) {
        const table = (
          tx as unknown as Record<string, { count: (args: unknown) => Promise<number> }>
        )[property];
        if (!table) {
          throw new Error(`The generated client has no ${property}. Run prisma generate.`);
        }
        const already = await table.count({});
        if (already > 0) {
          throw new Error(
            `${model} already holds ${already} rows. A restore goes into an empty database: make one and bring it up to date with pnpm db:deploy first.`,
          );
        }
      }

      // Everything, in one go, on one connection. `session_replication_role`
      // turns off triggers and foreign keys for this connection only — a
      // restore puts rows back exactly as they were, and the rules that refuse
      // an edit or a delete would otherwise refuse the rows they produced.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const { model, property, jsonFields } of tables()) {
        const waiting = (byModel.get(model) ?? []).map((row) =>
          emptyJsonIsNothing(row, jsonFields),
        );
        if (waiting.length === 0) {
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
        for (let start = 0; start < waiting.length; start += CHUNK) {
          await table.createMany({ data: waiting.slice(start, start + CHUNK) });
        }
        total += waiting.length;
        console.log(`  ${model}: ${waiting.length}`);
      }
      // Every line in the file belonged to a table this schema still has.
      if (total !== rows.length) {
        throw new Error(
          `Put back ${total} rows but the file holds ${rows.length}: it must have a table this schema does not.`,
        );
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
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

/** Where a connection string points, without the password. */
function describe(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'the database in DATABASE_URL';
  }
}

/**
 * A backup holds everybody's personal data, so it never goes where code goes:
 * one `git add .` and it would be published for ever.
 *
 * Windows and macOS treat `Backups` and `backups` as the same folder, so the
 * comparison ignores case there — otherwise a different capital letter walks
 * straight past the guard into the same place on disk.
 */
function refuseInsideTheRepository(path: string): void {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const ignoreCase = platform() === 'win32' || platform() === 'darwin';
  const same = (value: string) => (ignoreCase ? value.toLowerCase() : value);
  const inside = same(resolve(path));
  const root = same(repository);
  // The separator matters: a folder beside the repository whose name merely
  // starts the same way is not inside it.
  if (inside === root || inside.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(
      `Refusing to write a backup inside the repository (${path}). Choose a folder outside it with --to.`,
    );
  }
}
