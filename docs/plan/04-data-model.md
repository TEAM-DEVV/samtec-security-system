# 04 · Data model

The database is PostgreSQL, managed with Prisma. The executable version of this page is `apps/api/prisma/schema.prisma`.

## Naming convention

TypeScript uses camelCase (`firstName`), and the database uses snake_case (`first_name`). Prisma maps between them with `@map`, so hand-written SQL in later phases stays readable.

## Built in Phase 0

| Table | What a row is | Key rules |
|---|---|---|
| `companies` | The security company using SAMTEC | Version 1 has one row. Every business table stores `company_id` so more companies can be added later. |
| `sites` | A client location where guards are posted | Site code (`ACC-01`) unique per company |
| `employees` | A guard or staff member | Ghana Card number unique per company; staff number (`SMT-00042`) unique per company; never deleted. `biometric_enrolled_at` stays empty until biometrics are enrolled and pass the duplicate check. The workforce module owns the column; the attendance module sets it by calling the workforce service. |
| `site_assignments` | Where an employee is posted, from which date to which date | History kept; `ends_on` is empty for the current assignment. Stores `company_id` like every business table, and the workforce service checks it matches the employee's and the site's company. |

## Planned tables, by phase

```
Phase 1  identity:   users, sessions, audit_logs
         workforce:  posts, shift_patterns, employment_periods
Phase 2  attendance: devices, punch_events, work_segments, attendance_exceptions
Phase 3  attendance: biometric_credentials
Phase 4  payroll:    payroll_periods, payroll_runs, payroll_lines, tax_tables, payslips
Phase 5  detection:  detection_rules, detection_alerts
```

## The tables that carry the whole project

### punch_events: the ground truth (append-only)

| Column | Purpose |
|---|---|
| `id` | UUID version 7 |
| `device_id` | Which terminal or kiosk recorded the punch |
| `device_event_id` | **Unique together with `device_id`.** Re-sending a punch does nothing (idempotency). |
| `employee_id` | Matched from the device's user reference. Empty means unmatched, which creates an exception. |
| `device_time`, `server_time` | Both are stored. A difference of more than 5 minutes flags the device. |
| `direction` | IN, OUT or UNKNOWN. Some terminals do not send it, so pairing works it out. |
| `method` | FINGERPRINT, FACE or PIN_FALLBACK. PIN punches are flagged, never treated as equal. |
| `payload_hash` | A fingerprint of the raw device message, so tampering is detectable |

### payroll_lines: the snapshot

Everything needed to recalculate a payslip is **copied into the line** when the run is calculated: rate, hours, overtime hours, allowances, PAYE, SSNIT employee and employer amounts, and net pay. If an employee's rate changes later, history does not. Once a run is locked, a database trigger rejects any update or delete on its lines.

### biometric_credentials

- Stores **templates only** (the device vendor's format), encrypted with AES-256-GCM. The key is kept outside the database.
- Records a quality score, who enrolled it, and the duplicate-check result: PENDING, PASSED or COLLISION.
- A COLLISION blocks the employee's activation and opens a detection alert. This is how the system catches ghost worker trick number one: one person enrolled under two names.

### Rehiring (decided for Phase 1)

A guard who leaves and later returns keeps the **same employee record**, because a Ghana Card number can only belong to one employee. The `employment_periods` table (built), owned by the workforce module, records the hire date, termination date and reason for each period of work; the employee row holds the latest period.

## Row-level security on every table

Every migration that creates a table ends by switching on PostgreSQL **row-level security** for it. Prisma does not write this line, so add it by hand at the end of the new `migration.sql`:

```sql
ALTER TABLE "new_table" ENABLE ROW LEVEL SECURITY;
```

The API connects as the owner of the tables, and row-level security does not restrict a table's owner, so the API works normally. Any other database role sees no rows. This is a safety net for Supabase, whose Data API would otherwise let anyone with the project's public key read tables directly. The first migration also removes the privileges of Supabase's Data API roles (`anon` and `authenticated`), including on tables created later. Reviewers check for the line in every migration that adds a table.

## Rules, and where they are enforced

| Rule | Enforced by |
|---|---|
| A Ghana Card number belongs to one employee | Database unique constraint (Phase 0) |
| A staff number belongs to one employee | Database unique constraint (Phase 0) |
| Employees and sites are never deleted while history points to them | Foreign keys with `ON DELETE RESTRICT` (Phase 0) |
| Only the API can read the tables | Row-level security on every table, and Supabase's Data API switched off (Phase 0) |
| One current site assignment per employee | Workforce service (Phase 1), with a partial unique index in a SQL migration if tooling allows |
| A repeated punch is stored once | Unique `(device_id, device_event_id)` (Phase 2) |
| An employee's work segments never overlap | PostgreSQL exclusion constraint (Phase 2) |
| Money is integer pesewas | `INTEGER` columns and code review (Phase 4) |
| Payroll runs only move forward: DRAFT → PENDING_APPROVAL → LOCKED → PAID | Payroll service plus a database trigger (Phase 4) |
| The audit log can only grow | Database permissions: no UPDATE or DELETE (Phase 1) |
| A shared bank or mobile money number raises an alert | Detection rule R2 (Phase 5); allowed to save, because legitimate sharing exists |

## Seed data

`pnpm db:seed` creates a fictional company for development and demos.

- **Phase 0:** "Demo Security Company Ltd" with 5 sites and 50 employees (40 active, 6 waiting for enrollment, 2 suspended, 2 terminated). Names, phone numbers and Ghana Card numbers are fictional and obviously fake. Running the seed again updates the same rows instead of adding new ones.
- **Safety:** the seed refuses to write to a database that is not on your computer, unless you run it with `ALLOW_REMOTE_SEED=yes` on purpose (for example to fill the hosted demo).
- **Phase 2:** 30 days of punch history.
- **Phase 5:** three planted anomalies for the demo: a ghost on the payroll with no punches, a duplicate enrollment under two names, and a guard clocked in at two sites at the same hour. The demo is watching the detection engine catch all three.

Related: [System architecture](03-system-architecture.md) · [Ghost detection engine](08-ghost-detection-engine.md) · [Payroll engine (Ghana)](09-payroll-engine-ghana.md)
