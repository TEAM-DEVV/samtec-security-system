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
| `site_assignments` | Where an employee is posted, from which date to which date | History kept; `ends_on` is empty for the current assignment. Optionally records the post and shift pattern worked. Stores `company_id` like every business table, and the workforce service checks it matches the employee's and the site's company. |
| `posts` | A named guard position at a site, like "Main Gate" | Name unique per site; `required_guards` says how many guards it needs per shift; never deleted — `status` becomes INACTIVE. |
| `shift_patterns` | Company-wide working hours, like "Night Shift 18:00–06:00" | Times stored as minutes from midnight (checked 0–1439 by the database); an end at or before the start means the shift crosses midnight. Name unique per company. |
| `users` | A sign-in account (identity module) | Email unique per company and stored lower-case (a database CHECK). `password_hash` is empty while the owner has not yet chosen a password with their one-time link. SUPERVISOR and GUARD accounts must have `employee_id`, ADMIN and HR_PAYROLL must not (a database CHECK). Never deleted: `is_active` switches an account off. |
| `user_sessions`, `auth_challenges` | Refresh sessions; one-time sign-in steps and password links (identity module) | Only SHA-256 hashes of tokens are stored. A rotated session records the session that replaced it, which is how token reuse is told apart from a session that simply ended. |

## Planned tables, by phase

```
Phase 1  identity:   users, sessions, audit_logs
         workforce:  posts, shift_patterns, employment_periods
Phase 2  attendance: devices, punch_events, work_segments, attendance_exceptions
Phase 3  attendance: biometric_consents, biometric_credentials, biometric_exemptions,
                     device_passkeys, clock_in_attempts
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
| `method` | FINGERPRINT, FACE, FACE_PASSKEY (face, then the kiosk's fingerprint sensor), STAFF_PASSKEY (staff number, then fingerprint) or PIN_FALLBACK. STAFF_PASSKEY and PIN_FALLBACK punches are flagged, never treated as equal. |
| `payload_hash` | A fingerprint of the raw device message, so tampering is detectable |

### payroll_lines: the snapshot

Everything needed to recalculate a payslip is **copied into the line** when the run is calculated: rate, hours, overtime hours, allowances, PAYE, SSNIT employee and employer amounts, and net pay. If an employee's rate changes later, history does not. Once a run is locked, a database trigger rejects any update or delete on its lines.

### biometric_credentials

- Stores **templates only**, never images: a face template is 1,024 numbers from the kiosk, encrypted with AES-256-GCM and bound to its own row. The key is derived from `AUTH_SECRET`, which is kept outside the database. A ZKTeco finger stays on the terminal; we store only the proof that it was enrolled.
- Records who enrolled it and the duplicate-check result: PASSED, COLLISION, CLEARED (a second ADMIN decided this face may be used) or NOT_CHECKED (a terminal finger).
- A COLLISION keeps the employee pending until a second ADMIN decides: never the one who enrolled this face, nor anyone who revoked or withdrew a face of either record. For one person with two records (SAME_PERSON), the reviewer names the record to keep, and the other record is blocked for good. Phase 5's rule R1 reads these rows. This is how the system catches ghost worker trick number one: one person enrolled under two names.
- Consents and clock-in attempts are separate append-only tables, and fingerprint keys live in `device_passkeys`. The full design is in [Biometrics design](13-biometrics-design.md).

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
| Consents and clock-in attempts can only grow (the retention sweep may only clear an attempt's network address); faces, exemptions and fingerprint keys are never deleted | Database triggers (Phase 3, built) |
| At most one face in use per employee; one live fingerprint key per worker per kiosk; one exemption waiting or approved per employee | Partial unique indexes (Phase 3, built) |
| A wiped face never comes back; a block is final; a collision decision and an exemption decision are final; statuses only move forward; a key's signature counter only goes up | Database triggers (Phase 3, built) |
| A payroll period is exactly one calendar month, is closed once and never reopens | Database CHECK and trigger (Phase 4, built) |
| Every payroll line adds up: gross is the sum of its parts, and net is gross minus employee SSNIT, PAYE and other deductions | Database CHECK on every line (Phase 4, built) |
| Whoever calculated or submitted a payroll run can never approve or reject it | Database CHECK (Phase 4, built) |
| A run's status only moves forward, a locked run and its lines never change, and a month has at most one approved run | Database triggers and a partial unique index (Phase 4, built) |
| A tax table version a run has used can never be edited; its bands run 1..n with no gaps and the last has no upper limit | Database triggers (Phase 4, built) |
| Pay terms are history: a change in pay is a new row, never an edit | Database trigger (Phase 4, built) |
| Nothing in payroll is ever deleted or truncated — on any of the eight tables, in any state | Database triggers (Phase 4, built) |
| A bank account name can never hold a line break, or a spreadsheet formula, even behind a leading space | Database CHECK (Phase 4, built) |
| A payroll row can never hang off another company's record | Database trigger on every child row (Phase 4, built) |
| A run is born a draft in an open month, and the frozen list of who was left out has the shape the contract promises | Database triggers (Phase 4, built) |
| The ADMIN who enrolled a face never decides its collision; the ADMIN who asked never decides an exemption | Database CHECKs (Phase 3, built); the service applies the wider rules (docs/plan/13, section 2) |
| A serial number only on a ZKTeco terminal; fingerprints only on a kiosk | Database CHECK (Phase 3, built) |
| A face that collided is never matched at clock-in until a second ADMIN clears it; only a face that collided names a look-alike; a blocked face is never decided afterwards; one pair of records is never decided two ways | Database CHECKs and triggers (Phase 3, built) |
| The record that loses a SAME_PERSON decision keeps a blocked face, and no face, fingerprint key or exemption in use | A trigger that checks both records when the change is saved (Phase 3, built) |
| A new face, consent, exemption or fingerprint key starts undecided, on the right kind of device, inside the worker's company; a face needs the worker's own consent, still given (the database sets each consent's time); a blocked record gets nothing live, only a withdrawal of consent or a finger kept BLOCKED as evidence | Database triggers (Phase 3, built) |
| A collision decision or a block, and anything new for the same worker, happen one at a time, so two ADMINs working at the same moment cannot slip past each other | A lock on the worker's employee row, taken by the triggers (Phase 3, built); services that change several rows lock the workers first (docs/plan/13, section 2) |
| Switching a kiosk's fingerprints off must revoke every key on it, in the same transaction | A trigger checked when the change is saved (Phase 3, built) |
| A device keeps its company, site and kind for life | Database trigger (Phase 3, built) |
| An employee's counted (CONFIRMED) work segments never overlap | PostgreSQL exclusion constraint (Phase 2, see [12-attendance-design.md](12-attendance-design.md) §5) |
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
