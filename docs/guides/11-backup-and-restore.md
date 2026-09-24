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

The first line of the file records when it was taken and **which migration
the database was on**. A restore into a database on a different migration is
refused, because the columns would not line up.

## Putting one back

The database must exist, be empty, and be on the same migration:

```bash
pnpm db:deploy
pnpm --filter @samtec/api db:restore -- --from "D:/safe/samtec.ndjson"
```

Everything goes back in one transaction, on one connection, with
`session_replication_role = replica` set for that connection only. That turns
off triggers and foreign keys while the rows go in — which is necessary,
because SAMTEC's own rules refuse edits and deletes and would otherwise
refuse to accept the very rows they produced. Nothing else on the server is
affected, and the setting dies with the transaction.

## The drill, and its result

Done on 24 September 2026, against the local database with the full demo
data, on migration `20260924212734_phase_7_device_two_admins`.

| Step | Result |
|---|---|
| Back up | 12,450 rows, 8.0 MB, a few seconds |
| Destroy the database (`DROP DATABASE`) and rebuild it empty from the migrations | 11 migrations applied |
| Restore | 12,450 rows put back |
| Compare | employees 340 → 340, punches 7,106 → 7,106, payroll lines 14 → 14, audit log 596 → 596 |
| Awkward column types | a payslip PDF's bytes and its SHA-256, an 8,221-byte encrypted biometric template, and a two-factor counter held as a big integer all came back unchanged |
| Prove the system still works on it | the whole API test suite, 725 tests, against the restored database: all passed |

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
