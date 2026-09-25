# 11 · Backup and restore

What happens if the database is lost, and how we know it works. This is the
Phase 7 drill ([Roadmap](../plan/07-roadmap.md)), and the numbers below come
from actually doing it, not from reading the manual.

## The position today, plainly

**The hosted database has no backups.** The TEST project runs on Supabase's
free plan, where scheduled backups and point-in-time recovery are both paid
features — the dashboard says so on both tabs. An earlier version of
[Security and review gates](../plan/06-security-and-review-gates.md) claimed
"Supabase daily backups"; that was never true of this project, and the drill
below is what found it.

So the backup is ours:

```bash
pnpm --filter @samtec/api db:backup
```

It reads every table through the same client the API uses and writes one
file. It needs nothing installed — no `pg_dump`, no PostgreSQL tools — which
is the whole point: it runs from any computer that can check out this
repository and reach the database.

**A backup file is the entire company in one file:** names, Ghana Card
numbers, phone numbers, pay, bank details, and the encrypted biometric
templates. Keep it exactly where you would keep printed payslips. The script
refuses to write anywhere inside this repository, so one careless `git add`
can never publish it. By default it writes to `samtec-backups` in your home
folder.

## Taking a backup

```bash
# This computer's database.
pnpm --filter @samtec/api db:backup

# Somewhere else, and to a chosen file.
DATABASE_URL="postgresql://…" pnpm --filter @samtec/api db:backup -- --to "D:/safe/samtec.ndjson"
```

Every table is read **at one instant**, inside a single repeatable-read
transaction, so a row written while the backup runs can never land on one
side of a relationship and not the other.

The first line records when it was taken and **which migration the database
was on**. The last line records how many rows there should be. A backup cut
short — a full disk, a closed laptop — has no last line, and a restore
refuses it rather than quietly putting back whatever survived.

## Putting one back

```bash
pnpm db:deploy       # an empty database, on the same migration
pnpm --filter @samtec/api db:restore -- --from "D:/safe/samtec.ndjson" --yes
```

It refuses unless all of these hold, because each one is a way to destroy
data while believing you are saving it:

- **The file is whole** — the end marker is there and the row count matches.
- **The migration matches** the one the backup was taken on.
- **Every table is empty.** Restoring on top of existing rows is not a
  restore: with the rules turned off (below), two companies' data can merge
  without a single complaint.
- **You said `--yes`.** It prints which database it is about to fill —
  host and name, never the password — and stops unless you confirm.

Everything then goes back in one transaction, on one connection, with
`session_replication_role = replica` set for that connection only. That turns
off triggers and foreign keys while the rows go in — which is necessary,
because SAMTEC's own rules refuse edits and deletes and would otherwise
refuse to accept the very rows they produced. Nothing else on the server is
affected, and the setting dies with the transaction.

**An empty JSON column** is written back as "nothing recorded" (SQL NULL),
which is what this system always means by it. PostgreSQL can also hold the
JSON word `null` there, and Prisma cannot tell the two apart on the way
out — so a database that stored that word on purpose would come back with
SQL NULL instead. Nothing here stores it on purpose. This is written down
because getting it wrong the other way round silently rewrote 52 audit rows
during the drill below.

## The drill, and its result

Done on 25 September 2026, against the local database with the full demo
data, on migration `20260924212734_phase_7_device_two_admins`.

| Step | Result |
|---|---|
| Back up | 17,535 rows |
| Destroy the database (`DROP DATABASE`) and rebuild it empty from the migrations | 12 migrations applied |
| Restore | 17,535 rows put back |
| Compare | employees 617 → 617, punches 9,212 → 9,212, payslips 2 → 2, audit log 1,192 → 1,192 |
| Awkward column types | a payslip's PDF bytes, an 8,221-byte encrypted biometric template, and a two-factor counter held as a big integer all came back unchanged |
| Empty JSON columns | 52 audit rows with no detail came back as no detail — see the note above, because the first attempt got this wrong |
| The refusals | restoring into a database that still had rows, without `--yes`, and writing a backup inside the repository were each tried and each refused |
| Prove the system still works on it | the whole API test suite, 725 tests, against the restored database: all passed |

**On the hosted database**, the one privileged step a restore needs —
`SET LOCAL session_replication_role = 'replica'` — was run in Supabase's SQL
editor and accepted (role `postgres`, PostgreSQL 17.6). The full
backup-destroy-restore has **not** been rehearsed against it, because doing
that safely needs a throwaway project rather than the shared TEST one. Use
the direct connection string for a restore, not the transaction pooler: the
restore is one long transaction on one connection.

**What this proves:** a total loss of the database costs whatever has changed
since the last backup, and nothing else. **What it does not prove:** that
anybody is taking backups. Nothing schedules this yet — see below.

## What is still owed

- **Nobody takes a backup automatically.** Running the command is a person's
  job today. The honest fixes, in order of cost: pay for Supabase's daily
  backups (they also bring point-in-time recovery, which is what you actually
  want after a mistaken delete); or run `db:backup` on a schedule from a
  computer that is always on. Until one of those happens, the position is
  "restore works, and the last backup is however old the last person made it".
- **Before a payroll run is locked**, [Payroll engine (Ghana)](../plan/09-payroll-engine-ghana.md)
  decision 21 asks for a dump. Take one with `db:backup` before locking, and
  keep it with that month's records. The API cannot do this for itself: it
  runs as a serverless function with no PostgreSQL tools and no writable
  storage, and copying everybody's pay into another table inside the same
  database would add a second copy of personal data without adding any
  safety — the payroll tables already refuse every edit and every delete.

## Starting again on this computer

`pnpm db:reset` rebuilds the local database from scratch and seeds it. That is
for development, not recovery: it throws away whatever was there.
