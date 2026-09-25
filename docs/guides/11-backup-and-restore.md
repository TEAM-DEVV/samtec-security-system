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

## Taking one every week, without anybody remembering

```bash
pnpm --filter @samtec/api db:backup:scheduled
```

That is the command a scheduler runs. It takes a backup, keeps the newest 14
and deletes the rest — at the weekly cadence below, about three months of
history — and appends one line to `samtec-backups/backup-log.txt`, so a person
can see at a glance that it is still happening:

```
2026-09-25T09:41:25.643Z  OK  63314 rows from localhost:54329/samtec_dev into C:\Users\…\samtec-2026-09-25T09-41-21.ndjson
```

**Which database it backs up** is the one named in
`<your home folder>/.samtec/backup-database-url.txt` — one line, the whole
connection string. That file is outside this repository on purpose, so no
careless `git add` can ever reach it. `SAMTEC_BACKUP_DATABASE_URL` overrides it
for one run. With neither, it backs up whatever database the API uses on that
computer — the local one — and says so in the log rather than pretending.

The log never contains the password: it records the host and the database
name only.

Two more switches, both optional: `SAMTEC_BACKUP_DIR` (where the files go,
default `samtec-backups` in your home folder) and `SAMTEC_BACKUP_KEEP` (how many
to keep, default 14).

### The schedule on Windows

`apps/api/scripts/scheduled-backup.cmd` finds the repository from its own
location, so the task needs no paths of its own:

```bash
schtasks /Create /TN "SAMTEC weekly backup" /TR "<repo>\apps\api\scripts\scheduled-backup.cmd" /SC WEEKLY /D SUN /ST 13:00 /F
```

**A fixed weekday on purpose.** Every six days, or every ten, drifts across
the calendar, so nobody can ever say what the log should contain. "There is a
Sunday line every week" is a thing a person can check in two seconds, and a
missing one is obvious.

Set it to start when available, so a day the computer was switched off at
13:00 is caught up at the next opportunity instead of being missed silently:

```bash
powershell -Command "Set-ScheduledTask -TaskName 'SAMTEC weekly backup' -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1))"
```

Check on it with `schtasks /Query /TN "SAMTEC weekly backup" /FO LIST`, or
just read `backup-log.txt`.

**On this project's computer it is installed and proven**: it ran on 25
September 2026 with result 0, took 63,314 rows, kept the newest and deleted
the older ones, and is next due on Sunday at 13:00.

### Why not GitHub Actions

It is the obvious answer and it is the wrong one here. **This repository is
public**, and a workflow artifact on a public repository can be downloaded by
anybody who can see the repository — so a nightly job that uploaded the
backup would publish every Ghana Card number, bank account and sealed
biometric template in the company. A backup belongs on a machine somebody
owns, or in a private store bought for the purpose. Not in CI.

## What is still owed

- **A week is the most this can lose, and a week is too much for real pay.**
  Weekly is the right cadence for TEST, whose data is invented and whose worst
  case is reseeding it. It is the wrong cadence for a company's actual
  payroll: losing a week there means a week of punches, corrections and
  approvals gone. **Before real client data exists, buy Supabase's daily
  backups** — they also bring point-in-time recovery, which is what you
  actually want after a mistaken delete, and which no file-by-file backup can
  give you at any cadence.
- **The schedule is only as reliable as the computer it runs on.** A weekly
  task on a developer's laptop is a real improvement on nobody at all, but it
  is not a backup service: if the laptop is away, so is the backup. It catches
  up at the next opportunity rather than skipping, which is the most a laptop
  can promise.
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
