# 09 · Payroll engine (Ghana)

**Phase 4. Samuel builds this, end to end** — database, API and screens. See
[Who builds what next](14-work-split.md) for why, and
[How a backend module is built here](16-building-a-backend-module.md) for the
house style.

Money is integers (pesewas). Payroll runs are locked snapshots. Approval needs
a maker and a different checker. Statutory rates live in a **versioned tax
table**, not in the code: rates change with every national budget, so we update
a row instead of deploying new code.

> **Read the decisions section before you write any code.** The first draft of
> this page was a sketch, and a review found twenty-one places where a builder
> would have had to guess. They are all settled below. Where a decision limits
> version 1, that limitation is written down on purpose — it belongs in the
> report, not hidden in the code.

## Calculation pipeline (per employee, per period)

```
basic for the period (monthly salary, pro-rated by days employed)
 + overtime minutes × the overtime rate
 + allowances (taxable and non-taxable)
 = gross pay
 → SSNIT employee contribution: 5.5% of basic (the employer's 13% is a
   company cost, not a deduction)
 → taxable income = taxable gross − employee SSNIT
 → PAYE from the graduated monthly bands (table below)
 → net pay = gross − SSNIT (5.5%) − PAYE − other deductions
 → payroll line: every input copied into the line
```

## Statutory tables (seed values)

**Verify these against official GRA and SSNIT publications before the client
pilot.** Each tax table row stores its source and date.

**PAYE monthly bands for 2026 (graduated):**

| Chargeable income (GHS per month) | Rate |
|---|---|
| First 490 | 0% |
| Next 100 | 5% |
| Next 500 | 10% |
| Next 2,000 | 17.5% |
| Next 2,000 | 25% |
| Next 14,910 (up to 20,000) | 30% |
| Above 20,000 | 35% |

**SSNIT:** employee 5.5% plus employer 13%, a total of 18.5% of basic salary.
Of that 18.5%, SSNIT keeps 13.5% for Tier 1 and 5% goes to the employee's
Tier 2 fund. **Both percentages are of basic** — the 5% is not a slice of the
employer's 13%. Version 1 calculates and reports these amounts; paying them to
SSNIT stays manual.

The 2026 figures above came from online calculators and guides during
planning, which is exactly why they must be checked against the official GRA
publication in Phase 4. Selecting a tax year is itself a feature that
impresses both the examiner and the client.

## Hard rules

1. A run is calculated **only** from work segments and the pay terms visible
   at calculation time. Everything is copied into its lines.
2. A LOCKED run cannot change: a database trigger rejects it. Corrections
   become adjustment lines in the next period, pointing to the original line.
3. The maker (who creates and submits) is never the checker (who approves).
   The server compares user IDs, and so does a database CHECK.
4. Detection rule R3 will block a submission when unexplained differences
   appear between paid hours and punched hours — **from Phase 5 onward**. See
   decision 8.
5. Rounding happens once, half-up, at the final pesewa. A property-based test
   proves that the lines always add up exactly to the run totals.
6. Payslip PDFs are generated once, when the run locks, and stored. What was
   sent is exactly what exists.

---

# The twenty-one decisions

## Data that did not exist yet

**1. Pay terms.** No employee in the database has a salary. Payroll adds
`employee_pay_terms`, **owned by the payroll module** (the workforce module
owns the person; payroll owns what they are paid). One row per employee per
change, effective-dated, never edited:

| Column | Meaning |
|---|---|
| `employee_id` | Who |
| `effective_from` (date) | From when. A new row supersedes the last |
| `basic_monthly_pesewas` | The monthly salary |
| `overtime_hourly_pesewas` | Paid per overtime hour |
| `taxable_allowance_pesewas` | Monthly, taxed |
| `non_taxable_allowance_pesewas` | Monthly, not taxed |
| `other_deduction_pesewas` | Monthly, e.g. a uniform or loan instalment |

A run reads the row whose `effective_from` is the latest one on or before the
period's **last** day, and copies every value into the line.

**2. Payment details.** No bank account or mobile money number exists either,
and the bank export needs them. Payroll adds `employee_payment_details`:
`bank_name`, `account_name`, `account_number`, `momo_number`, all nullable,
one row per employee, editable. **This is personal data**: never log it, never
put it in an error message, and never return it on a list endpoint that a
supervisor can read.

## How the money is worked out

**3. Overtime.** Regular minutes are the minutes the worker's **assigned shift
pattern** schedules for that work date. Anything confirmed beyond that is
overtime, paid at `overtime_hourly_pesewas`.

The scheduled length comes from the shift pattern on the worker's
`site_assignments` row covering that date. `ShiftPattern` stores
`start_minutes` and `end_minutes` as minutes from midnight, and a night shift
wraps past midnight, so:

```
scheduled = ((end_minutes - start_minutes) + 1440) % 1440
```

A worker with no assignment, or an assignment with no shift pattern, falls
back to **480 minutes** (8 hours). Compare the day's total
`worked_minutes` across that date's CONFIRMED segments against `scheduled`:
the excess is overtime, the rest is regular.

There is no night premium and no public-holiday premium in version 1 — a
stated limitation.

**4. Monthly salary, not hourly pay.** `basic_monthly_pesewas` is paid in full
when the worker was employed for the whole period, and **pro-rated by calendar
days employed** when they joined or left inside it. Hours worked do **not**
reduce basic: absence is handled by the attendance exception queue and by
ghost detection, not by silently docking pay. Overtime is added on top.

**5. Which minutes belong to the period.** A segment belongs to the period its
`work_date` falls in — the date the attendance module already assigned it.
A night shift starting on the 30th and ending on the 1st is therefore paid in
the month it started. This is the definite answer the "night shift crossing
the period boundary" golden test needs.

**6. Only CONFIRMED segments are paid.** DISPUTED and VOIDED segments are
skipped, exactly as [Attendance design](12-attendance-design.md) says.

**7. Who is on the run.** Every employee who was employed for at least one day
of the period and has pay terms effective by its last day — including
`PENDING_ENROLLMENT` workers, because being employed and being enrolled in
biometrics are different things. `SUSPENDED` workers are **left off the run**
and listed in its summary as "not paid: suspended", so nobody is silently
dropped.

**8. Payroll does not call ghost detection yet.** Hard rule 4 says detection
rule R3 blocks a submission — but detection is Phase 5 and payroll is Phase 4.
So version 1 **records the evidence** on each line
(`punched_minutes`, so the checker can see paid hours against punched hours)
and lets the submission through. Francis wires the block in during Phase 5,
without changing the line's shape.

**9. Precision.** Percentages and tax bands produce fractions at every step.
Do the whole calculation in **integer ten-thousandths of a pesewa** (a plain
`bigint`), and round **half-up, once**, at the very end of each line. Never
use a floating point number for money anywhere.

## The tax table

**10. Shape.** Two tables. `tax_tables` holds one row per version: a
`tax_year` label, `effective_from`/`effective_to` dates, the four SSNIT
percentages as **basis points** (550, 1300, 1350, 500), and the source —
`source_name`, `source_url`, `source_checked_on` — because a rate nobody can
trace is a rate nobody can defend. `tax_bands` is its child: `ordinal`,
`width_pesewas` (null for the top, unbounded band) and `rate_basis_points`.

**11. Scope.** Like every other business table, `tax_tables` carries
`company_id` and is seeded per company. The rates are national, but keeping
the column keeps the row-level security model identical everywhere, which is
worth more than saving one duplicated row.

**12. A version is frozen once a run uses it.** A trigger rejects UPDATE and
DELETE on a referenced row, so a locked run's arithmetic can always be
reproduced. A rate change is a **new** row. A period that straddles a rate
change uses the version effective on the period's **last** day.

## What version 1 deliberately leaves out

Write these in the report as limitations, not as bugs.

**13. No personal tax reliefs**, and bonus income is not taxed separately.
Real Ghanaian PAYE has both.

**14. No allowance catalogue.** Two monthly figures, taxable and non-taxable.
Naming each allowance, and the Ghanaian caps on which ones are exempt, is
future work.

**15. Closing a period blocks nothing in attendance.** A run is a snapshot, so
a punch that arrives late for a closed month does not corrupt it. The
correction becomes an adjustment line in the next period (hard rule 2). A
freeze on attendance edits is future work.

## The run's life

**16. States.** `DRAFT → PENDING_APPROVAL → LOCKED → PAID`, and
`PENDING_APPROVAL → REJECTED`, which is **terminal**. A checker who finds a
wrong line rejects the run with a reason; the maker fixes the cause and
calculates a **new** run. Nothing ever moves backwards, so the "only move
forward" rule in [Data model](04-data-model.md) holds.

**17. Several runs per period are allowed** (drafts and rejected ones), but a
partial unique index permits **at most one** that is LOCKED or PAID.

**18. Who does what.** `HR_PAYROLL` prepares, submits and reads. `ADMIN`
approves, rejects and marks paid. An ADMIN may also prepare — and then a
**different** ADMIN must approve. A `GUARD` may read **only their own**
payslips; a record they may not see answers 404, never 403. A `SUPERVISOR`
sees no payroll at all.

**19. Marking a run paid** is an ADMIN's job, after the bank file has been
sent. It records who and when. No second person is required, because the money
has already left by then — the control that matters is the approval before it.

**20. An adjustment line** is an ordinary line in the **next** period's run
with `adjusts_line_id` pointing at the original, and an amount that may be
negative. "Signed" means it carries the approval of whoever approved that run —
not a cryptographic signature.

**21. The database dump before every lock** that
[Security and review gates](06-security-and-review-gates.md) asks for is a
Phase 7 task for Francis, not part of this build.

---

# What to build

## Tables

Payroll owns these and nothing else writes to them: `payroll_periods`,
`payroll_runs`, `payroll_lines`, `tax_tables`, `tax_bands`, `payslips`,
`employee_pay_terms`, `employee_payment_details`.

Every one of them: `company_id`, row-level security switched on, `uuid(7)`
primary key, timestamps in `timestamptz(3)`, money as `INTEGER` columns whose
names end in `Pesewas`. Read the generated `migration.sql` before committing
it (CLAUDE.md rule 9).

The rules the **database** must enforce, not just the code:

- A period moves OPEN → CLOSED and never back; a closed period records who
  closed it and when, together.
- A run's status only moves forward; every status carries its full evidence
  (`PENDING_APPROVAL` has a submitter and a time, `LOCKED` also has an
  approver and a time).
- `CHECK (submitted_by_user_id <> approved_by_user_id)` — maker and checker,
  in the database itself, the same way the Phase 3 biometric tables do it.
- Once a run is LOCKED, a trigger rejects every UPDATE and DELETE on that run
  and on its lines.
- `CHECK (net_pay_pesewas = gross_pesewas − ssnit_employee_pesewas −
  paye_pesewas − other_deductions_pesewas)` on every line, so a bug in the
  code cannot write a line that does not add up. The employer's SSNIT never
  appears in that sum.
- Nothing is ever deleted: no DELETE, no TRUNCATE, on any payroll table.

## Endpoints

All under `/payroll`, all new to the contract. Add them inside the
`# --- Payroll (Phase 4) ---` banners in `openapi.yaml`, and name every schema
and operation with its module prefix (`PayrollRun`, `listPayrollRuns`).

| Endpoint | Who |
|---|---|
| `GET /payroll/periods`, `POST /payroll/periods`, `POST /payroll/periods/{id}/close` | ADMIN, HR_PAYROLL |
| `GET /payroll/runs`, `GET /payroll/runs/{id}`, `GET /payroll/runs/{id}/lines` | ADMIN, HR_PAYROLL |
| `POST /payroll/runs` (calculate a draft) | ADMIN, HR_PAYROLL — the caller becomes the maker |
| `POST /payroll/runs/{id}/submit` | The maker |
| `POST /payroll/runs/{id}/approve`, `/reject` | ADMIN, never the submitter |
| `POST /payroll/runs/{id}/mark-paid` | ADMIN |
| `GET /payroll/runs/{id}/bank-export` | ADMIN, HR_PAYROLL — `text/csv` |
| `GET /payroll/runs/{id}/statutory-summary` | ADMIN, HR_PAYROLL |
| `GET /payroll/payslips`, `GET /payroll/payslips/{id}` | The owning guard, ADMIN, HR_PAYROLL |
| `GET /payroll/payslips/{id}/pdf` | The owning guard, ADMIN, HR_PAYROLL — `application/pdf` |
| `GET`/`POST /payroll/tax-tables` | ADMIN |
| `GET`/`PUT /employees/{id}/pay-terms`, `PUT /employees/{id}/payment-details` | ADMIN, HR_PAYROLL |

The contract has been JSON-only until now. These are the first two downloads:
document their content types in `openapi.yaml` and update the "JSON only" line
in [API contract](05-api-contract.md) in the same change.

## The payslip PDF

Generated once, in the same transaction that locks the run, and stored as
bytes in `payslips`. The stack has no object storage, and a few hundred guards
a month is well within what PostgreSQL holds comfortably.

Use **`pdfkit`** (MIT, pure JavaScript, no native build, no headless browser).
Adding it needs a line in [Stack decisions](02-stack-decisions.md) in the same
pull request — CLAUDE.md rule 11.

## Test strategy

The payroll engine gets the highest test coverage in the repository. Golden
files contain hand-calculated guards, and the engine must match each one **to
the pesewa**:

1. below the tax-free threshold (basic 450);
2. mid-band, no overtime;
3. overtime-heavy;
4. joined mid-month (pro-rated basic);
5. left mid-month;
6. a night shift that crosses the period boundary;
7. taxable and non-taxable allowances together;
8. the top band, above 20,000.

Plus a property-based test proving the lines always sum exactly to the run
totals, and end-to-end tests proving: the same person cannot approve their own
run; a locked run cannot be edited (the database refuses); and a guard reading
another guard's payslip gets 404.

Related: [Data model](04-data-model.md) ·
[Ghost detection engine](08-ghost-detection-engine.md) ·
[How a backend module is built here](16-building-a-backend-module.md)
