/**
 * Takes a backup without anybody remembering to, and keeps the last few.
 *
 *   pnpm --filter @samtec/api db:backup:scheduled
 *
 * This is the wrapper a scheduler calls. The backup itself is still
 * `scripts/backup.ts`; this decides **which** database, **where** the file
 * goes, **how many** to keep, and writes one line to a log so a person can
 * see at a glance that it is still happening.
 *
 * ## Which database
 *
 * In order:
 *
 * 1. `SAMTEC_BACKUP_DATABASE_URL`, if it is set.
 * 2. The first non-empty line of the file named by `SAMTEC_BACKUP_URL_FILE`,
 *    which defaults to `<your home folder>/.samtec/backup-database-url.txt`.
 * 3. Whatever `DATABASE_URL` the backup script itself finds — on a developer's
 *    machine that is the local database, which is almost never what a
 *    schedule is for.
 *
 * **A backup of a database on this computer is marked `REHEARSAL`, not `OK`**,
 * however it was chosen. It is the same work and the same file, but it
 * protects nothing that is not already on this machine, and a log that called
 * it `OK` would read like a working backup for months.
 *
 * The file exists so the connection string lives **outside this repository**,
 * where no `git add` can reach it. Nothing here ever prints the password: the
 * log records the host and the database name only.
 *
 * ## Where the files go
 *
 * `<your home folder>/samtec-backups`, the same place `db:backup` uses,
 * unless `SAMTEC_BACKUP_DIR` says otherwise. The newest
 * `SAMTEC_BACKUP_KEEP` files are kept (14 by default) and older ones are
 * deleted — only files this script itself writes, matched by name. At the
 * weekly cadence this project runs, 14 is about three months of history.
 *
 * **Not a public artifact, and not this repository.** A backup is the whole
 * company in one file: names, Ghana Card numbers, pay, bank details and the
 * sealed biometric templates. This repository is public, so a scheduled job
 * that uploaded the file to GitHub would publish all of it. It stays on a
 * machine somebody owns. See docs/guides/11-backup-and-restore.md.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_DEFAULT = 14;
const BACKUP_NAME = /^samtec-.*\.ndjson$/;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * True when this address is a database on the machine running the script.
 *
 * It matters because a schedule pointed at a developer's own database looks
 * exactly like a working backup in the log — the same "OK", the same row
 * count — while backing up nothing anybody would miss. Saying it out loud
 * every single time is the only way the log cannot quietly lie.
 */
function isOnThisComputer(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Where a connection string points, without the password. */
function describe(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'an address that could not be read';
  }
}

/**
 * The database to back up, and where the answer came from. `undefined` means
 * "let the backup script decide", which is the developer's own machine.
 */
function chooseDatabase(): { url?: string; source: string } {
  const fromEnv = process.env.SAMTEC_BACKUP_DATABASE_URL?.trim();
  if (fromEnv) {
    return { url: fromEnv, source: 'SAMTEC_BACKUP_DATABASE_URL' };
  }

  const path =
    process.env.SAMTEC_BACKUP_URL_FILE?.trim() ||
    join(homedir(), '.samtec', 'backup-database-url.txt');
  try {
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.length > 0 && !text.startsWith('#'));
    if (line) {
      return { url: line, source: path };
    }
    return { source: `${path} (no address in it yet)` };
  } catch {
    return { source: `${path} (not there yet)` };
  }
}

/** Runs the real backup script and returns what it printed. */
function takeBackup(url: string | undefined, to: string): Promise<string> {
  return new Promise((done, failed) => {
    const child = spawn(
      process.execPath,
      [
        join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(here, 'backup.ts'),
        '--to',
        to,
      ],
      {
        cwd: resolve(here, '..'),
        env: url ? { ...process.env, DATABASE_URL: url } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString();
    });
    child.on('error', failed);
    child.on('close', (code) => {
      if (code === 0) {
        done(said.trim());
      } else {
        failed(new Error(said.trim() || `The backup script stopped with code ${code}.`));
      }
    });
  });
}

/**
 * Deletes all but the newest `keep` backups in this folder. Only files this
 * script writes are ever considered, by name, so nothing else in the folder
 * can be caught by it.
 */
function keepTheNewest(folder: string, keep: number): number {
  const ours = readdirSync(folder)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const path = join(folder, name);
      return { path, at: statSync(path).mtimeMs };
    })
    .sort((one, other) => other.at - one.at);

  let removed = 0;
  for (const old of ours.slice(keep)) {
    unlinkSync(old.path);
    removed += 1;
  }
  return removed;
}

function stampedName(): string {
  return `samtec-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.ndjson`;
}

async function main(): Promise<void> {
  const folder = process.env.SAMTEC_BACKUP_DIR?.trim() || join(homedir(), 'samtec-backups');
  const keep = Number(process.env.SAMTEC_BACKUP_KEEP ?? KEEP_DEFAULT);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('SAMTEC_BACKUP_KEEP must be a whole number, 1 or more.');
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });

  const log = join(folder, 'backup-log.txt');
  const note = (line: string) => {
    const stamped = `${new Date().toISOString()}  ${line}`;
    console.log(stamped);
    appendFileSync(log, `${stamped}\n`, { mode: 0o600 });
  };

  const chosen = chooseDatabase();
  if (!chosen.url) {
    note(
      `WARNING: no database was named (${chosen.source}), so this backed up whatever the API uses on this computer — on a developer's machine that is the local database, not the real one.`,
    );
  }

  const to = join(folder, stampedName());
  try {
    const said = await takeBackup(chosen.url, to);
    const rows = /([\d,]+)\s+rows?/.exec(said)?.[1] ?? 'an unknown number of';
    const where = chosen.url ? describe(chosen.url) : 'this computer';
    const removed = keepTheNewest(folder, keep);
    const rehearsal = !chosen.url || isOnThisComputer(chosen.url);
    note(
      `${rehearsal ? 'REHEARSAL' : 'OK'}  ${rows} rows from ${where} into ${to}${removed > 0 ? `, and ${removed} older backup${removed === 1 ? '' : 's'} deleted (keeping ${keep})` : ''}`,
    );
    if (rehearsal) {
      note(
        'REHEARSAL: that database lives on this computer, so this backup protects nothing that is not already here. Name the real one in the file above to make it count.',
      );
    }
  } catch (problem) {
    note(`FAILED  ${problem instanceof Error ? problem.message.split('\n')[0] : String(problem)}`);
    process.exitCode = 1;
  }
}

await main();
