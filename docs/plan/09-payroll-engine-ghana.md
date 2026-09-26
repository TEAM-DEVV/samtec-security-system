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
Phase 7 task for Francis, not part of this build. **Done, as an operator
step, not an API one**: take one with `pnpm --filter @samtec/api db:backup`
before locking and keep it with that month's records
([Backup and restore](../guides/11-backup-and-restore.md)). The API cannot do
it for itself — it runs as a serverless function with no PostgreSQL tools and
no writable storage, and copying everybody's pay into another table inside
the same database would add a second copy of personal data without adding any
safety, because the payroll tables already refuse every edit and every
delete.

---

# Added during the build, after the four-lens review

The twenty-one decisions above were settled before any code was written. The
four review lenses then found questions the design had not answered, and rules
it had assumed rather than stated. Decisions 22 to 24 came out of the contract
review, and 25 and 26 out of building the engine and the endpoints — 25 in
particular corrects decision 22, which asked for something that turned out to
be unsafe.

**22. The approval covers the amount, not the destination.** A run is a locked
snapshot of what each worker is *owed*, and a trigger refuses to change it. But
`employee_payment_details` is edited in place and the bank export reads it when
the file is downloaded, which is after the checker has signed the run off. So
an HR user could have a correct run approved and then move one worker's account
number before producing the file, and maker–checker would not have covered it.

Version 1 answers this by making the change **visible and traceable**, not by
blocking it: a worker really does sometimes change bank account between the
approval and the payment, and a rule that forces a whole new run for that would
be worked around.

- The bank export carries a last column, `details_changed_after_approval`,
  which is `yes` for any worker whose payment details were changed after the
  run was approved. Whoever uploads the file sees it before the money moves.
- Downloading the bank export is **audited**: who, which run, and when. It is
  the one endpoint that returns every account number in the company, so it
  should not be the one endpoint that leaves no trace.
- Changing payment details is audited with a **SHA-256 of the account number**,
  never the number itself, so an investigation can later prove which account
  was in force without the audit log ever holding one.

Freezing the details onto the run at lock time was considered and rejected for
version 1: it would put bank details inside the payroll tables, which decision 2
deliberately keeps them out of. If a client later needs the stronger rule, the
change is to copy a `payment_details_id` onto each line at lock time and read
the snapshot in the export.

**23. The bank file is a money instruction, so it is escaped like one.** Every
cell is written as RFC 4180 says — always quoted, with every quote inside it
doubled — so a name or an account holder containing a comma, a quote or a line
break can never break a row apart or add a payee. A cell whose value begins
with `=`, `+`, `-`, `@` or a tab is written with a leading apostrophe, so a
spreadsheet shows it instead of running it. `bankName` and `accountName` also
refuse those leading characters, and any tab or line break, at the contract
boundary.

**24. Every figure on a payslip is worked out from the figures printed beside
it.** Decision 9 says to calculate in ten-thousandths of a pesewa and round
half-up once at the end of each line. Followed literally that produces a
payslip which does not add up: if gross is the rounded sum of the unrounded
parts, while basic and overtime are each rounded on their own, the printed
parts can total one pesewa less than the printed gross. A guard checking their
own payslip with a calculator would find SAMTEC wrong.

So the rule is sharpened, and this is what the engine implements:

- Only the two amounts that need a **division** are rounded: the basic pay
  pro-rated by days employed, and the overtime. Each is one exact fraction,
  rounded half-up exactly once, to a whole pesewa.
- **Everything after that is addition and subtraction of those already-rounded
  pesewas.** Gross is the sum of its four parts. Taxable gross is the sum of
  its three. Employee SSNIT is a percentage of the rounded basic. Chargeable
  income is taxable gross minus employee SSNIT. PAYE is the graduated bands
  applied to that chargeable income. Net pay is gross minus employee SSNIT,
  PAYE and other deductions.
- Nothing is rounded twice, no floating point number appears at any step, and
  every rate still comes from the tax table version, never from the code.

The effect is that the whole payslip can be re-derived by hand from the numbers
on it, the run totals are the exact sums of the line values, and
`net_pay_pesewas = gross − SSNIT − PAYE − other` holds by construction, so the
database `CHECK` can never be broken by rounding.

Two small rules that follow, written down so the API cannot quietly pick
differently:

- **Half-up means half away from zero.** An adjustment line may be negative
  (decision 20), so −0.5 pesewas rounds to −1, not to 0.
- **The last PAYE band must have no width.** A tax table whose top band is
  bounded would leave the highest earners silently untaxed, so the API refuses
  one at the boundary.

**A limitation to write in the report, not a bug:** allowances and the monthly
other-deduction are not pro-rated, only the basic is (decision 4 names only the
basic). A worker employed for one day of a month therefore receives a whole
month's allowance and has a whole month's uniform or loan instalment taken off.
Where that leaves a net pay of zero or less, the bank file leaves the row out —
a bank cannot take a negative payment — and the payroll line and the payslip
still show it, so the money is recovered by an adjustment line in a later
period.

**25. The audit log records that a bank destination changed, never a hash of
it.** Decision 22 said the change should be recorded with a SHA-256 of the
account number, so a later reader could prove which number had been replaced
without the log holding the number itself. Building it showed that reasoning
does not hold. A Ghanaian bank account number is ten to thirteen digits in
practice, and a mobile money number is nine digits behind a fixed `+233` — so
the space to search is between a billion and ten trillion values, which a
graphics card hashes in minutes to hours. (The column allows up to twenty
digits, and twenty truly random digits would be out of reach; real account
numbers are not random, they are a bank prefix and a branch code followed by a
short serial, which is why the practical figure is the one that matters.) A
hash of one is therefore the number in any sense that counts, and storing it
in an append-only log would put a bank account number somewhere it can never
be removed from — against hard rule 8 and
against Act 843's data minimisation.

So the log records only which fields moved (`bankAccountChanged`,
`momoChanged`), who moved them, and when. The question decision 22 actually
wanted answered — *did the destination change after somebody approved this
money?* — is answered instead by comparing the payment details row's
`updated_at` with the run's `approved_at`, which is where the bank file's
`details_changed_after_approval` column comes from. The account number then
lives in exactly one place, which is the only way to be sure where it is.

**26. The two SSNIT tiers are derived, not calculated twice.** Tier 1 (13.5% of
basic) and Tier 2 (5%) are a split of the same 18.5% that the employee's 5.5%
and the employer's 13% add up to. Rounding all four independently broke that
for about a third of possible salaries by one pesewa — basic GHS 1,200.19 gives
22,203 pesewas contributed but 22,204 split — and the statutory summary reports
both figures, so they have to tie. Tier 2 is therefore
`employee + employer − tier1`, and a tax table whose four percentages do not
add up is refused at the boundary rather than quietly producing a summary that
does not reconcile.

**27. Rule R3 refuses two different things, because minutes cannot see the
plainest ghost.** Added 2026-09-26, after a four-lens review of the approval
chain found the gap and a verifier reproduced it against the local database:
2,454 payroll lines worth GHS 3,240,802.32 had been submitted, approved and
paid for workers with no attendance record at all.

The gate compares hours paid against hours present, both counted from the
attendance tables. For a worker who never came to work, both numbers are zero,
so the comparison passes — and they are still paid, because **basic pay is
pro-rated by calendar days employed, not by attendance** (see "How the money is
worked out"). A ghost worker on a monthly salary is therefore invisible to any
comparison of minutes, which is exactly the fraud this system exists to stop.

So the gate refuses a line when *either* of these is true:

- `paidBeyondPresence(paid, present, 60) > 0` — it pays for more hours than the
  records support. This is what catches a shift disputed or voided after the run
  was calculated.
- `present === 0 && netPay > 0` — it pays somebody who was never here.

**What this costs.** A worker who is legitimately paid without clocking in —
somebody on paid leave, or a salaried supervisor who does not use a kiosk — now
blocks a submission. Version 1 has no way to record either, so today the honest
answer is that such a worker cannot be paid through a run; hard rule 2's
adjustment line is where that belongs, and nothing can create one yet. The
choice is deliberate and it fails closed: refusing to pay somebody who should be
paid is a conversation, and paying a ghost is a loss nobody notices. When paid
leave arrives, the second condition gains an exception for it and this decision
is revisited — not the first condition, which stands on its own.

**What it still does not catch, and why that is a choice.** A salaried worker
who came once and was paid a full month passes: presence is not zero, and their
basic pay was never proportional to attendance in the first place. The gate draws
its line at *nothing at all*, because that is the only point where the answer is
unambiguous — anything between one day and twenty is a management question about
absence, not a fraud test, and it is what the absence figure on the Reports page
and detection's R5 are for. Moving that line would mean deciding how much
absence makes a salary fraudulent, which is a company's policy and not a
developer's.

**Where it is enforced.** `refuseHoursNobodyWorked` in
`payroll-approval.service.ts`, on submission only. Detection's own R3 makes the
same comparison afterwards as a sweep; the submission gate is the floor and the
sweep may be stricter, never looser.

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

**Written by hand, with no library.** This page used to say to use `pdfkit`.
Decision 24 in [Stack decisions](02-stack-decisions.md) reversed that: neither
`pdfkit` nor any of its six runtime dependencies publishes a provenance
attestation on any version, and it adds about 10 MB to a serverless function.
A one-page payslip needs a few hundred lines of PDF, no fonts embedded (the
fourteen standard fonts are in every reader), and it is testable to the byte —
see [`payslip-pdf.ts`](../../apps/api/src/modules/payroll/payslip-pdf.ts) and
the module's own README.

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
