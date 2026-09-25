# payroll module (Phase 4)

**Purpose:** correct Ghanaian pay, calculated from verified attendance,
approved by a second person, and then frozen for ever.

Design: [docs/plan/09-payroll-engine-ghana.md](../../../../../docs/plan/09-payroll-engine-ghana.md).
Read it before changing anything here — every question this module could raise
is settled there, in twenty-four numbered decisions.

## Tables it owns

`payroll_periods`, `payroll_runs`, `payroll_lines`, `payslips`, `tax_tables`,
`tax_bands`, `employee_pay_terms`, `employee_payment_details`.

Nothing outside this module writes to them, and this module writes to nothing
else: it asks the workforce module about people and the attendance module
about confirmed shifts.

## Rules that must hold

- **Money is always an integer number of pesewas.** Never a decimal, never a
  float, not even for an intermediate value.
- **Every figure is worked out from the figures printed beside it**
  (decision 24). Only the pro-rated basic and the overtime are rounded, once
  each, half-up; everything else is addition and subtraction of those. So a
  worker can check their own payslip with a calculator, the run totals are the
  exact sums of the lines, and `net = gross − SSNIT − PAYE − other` holds by
  construction.
- **Rates come from a versioned `tax_tables` row**, never from a number in the
  code, and a version a run has used can never be edited afterwards.
- **A run copies every input into its lines**, so a locked run can be
  re-checked years later without reading anything else.
- **The maker is never the checker.** Whoever calculated or submitted a run
  may never approve or reject it.
- **The lines freeze when a run is submitted**, not when it is approved, so
  the numbers a checker reads are the numbers that get frozen. A correction
  after that means rejecting the run and calculating a new one.
- **A locked run never changes**, and nothing in payroll is ever deleted — no
  DELETE and no TRUNCATE, on any of the eight tables, in any state.
- **`employee_payment_details` is personal data.** It is never logged, never
  put in an error message, and never returned by a list endpoint; it exists on
  the endpoint that sets it and inside the bank export, and nowhere else. The
  audit log records only which fields moved, never a value and never a hash of
  one: an account number is short enough that its hash can be worked backwards
  in minutes (decision 25).

## The files

| File | What it is for |
|---|---|
| `payroll.module.ts` | The wiring: which controllers, which services, what it imports |
| `payroll.controller.ts` | Every `/payroll/*` route. HTTP only, one method per contract operation |
| `employee-pay.controller.ts` | `/employees/{id}/pay-terms` and `/payment-details`. They hang off a person, but the data is payroll's |
| `payroll.schemas.ts` | Every Zod input rule for the module, in one file. Always `strictObject` |
| `payroll-periods.service.ts` | Opening a month, listing months, closing one for good |
| `payroll-runs.service.ts` | Calculating a draft run from the company's own records, and reading one back |
| `tax-tables.service.ts` | The statutory rates, as versions that are never edited |
| `employee-pay.service.ts` | Pay history (append-only) and payment details (edited in place) |
| `payroll-mapping.ts` | Database rows to contract shapes, as pure functions |
| `run-mapping.ts` | The same for runs and lines, including the totals, which are the exact sums of the lines |
| `payroll-facts.service.ts` | The read seam for ghost detection: minutes and identifiers, never money |
| `pay-calculation.ts` | The money, as a pure function: pro-rating, SSNIT, the graduated PAYE bands, net pay. No database, no `this` |
| `worked-minutes.ts` | Which shifts belong to the period, which minutes are overtime, and how many days somebody was employed. Also pure |
| `tax-band-shape.ts` | Whether a set of PAYE bands covers every income, so a bad one is a clear 400 and not a trigger error |
| `payroll-cursor.ts` | The one cursor every payroll list pages by, checked so a bad one is a 400 |
| `already-exists.ts` | Turns a duplicate row into the 409 the contract promises instead of a 500 |
| `*.spec.ts` | The unit tests beside each one, including the eight hand-calculated payslips from the design page |

The rules the **database** enforces live in the migration
`20260924004536_phase_4_payroll`, and are proved against a real PostgreSQL by
[`test/payroll-rules.e2e-spec.ts`](../../../test/payroll-rules.e2e-spec.ts).

## A trap for the payment details screen

**There is no `GET` for payment details, and that is deliberate** — the fewer
places a bank account number can be read, the fewer places it can leak. But it
has a consequence the screen must handle, because the API cannot.

`PUT /employees/{id}/payment-details` requires all four fields and replaces all
four. A screen cannot pre-fill the form, because nothing will tell it what is
there now. So a form that sends only the mobile money number, leaving the bank
fields as empty strings or `null`, **silently wipes the bank account** — and
nothing will report an error, because clearing a field is a legitimate thing to
ask for.

The screen therefore has to say plainly that saving replaces every payment
detail, and ask for all of them together. Do not solve this by adding a `GET`;
solve it in the form.

## Writing tests that touch these tables

**A payroll test makes its own company.** It cannot use `TEST_COMPANY_ID` from
[`test/db-fixture.ts`](../../../test/db-fixture.ts), because `resetFixture`
deletes that company's employees, and an employee with pay terms can never be
deleted — the pay terms reference it with `onDelete: Restrict`, and payroll rows
can never be removed to clear the way. The first test that writes payroll rows
for the shared fixture company would break `resetFixture` for **every**
database-backed test in the repository, permanently, with no way back except
`pnpm db:reset`.

[`test/payroll-rules.e2e-spec.ts`](../../../test/payroll-rules.e2e-spec.ts)
shows the pattern: a `randomUUID()` company per run, and no cleanup afterwards.
That leaves a company behind on each local run, which is harmless — run
`pnpm db:reset` when the local database feels cluttered.

## The read seam, and the one thing submission must do

[`payroll-facts.service.ts`](payroll-facts.service.ts) is how ghost detection
asks what was paid: minutes and identifiers, never money, and nothing outside
payroll touches the tables. It sits in
[`payroll.module.ts`](payroll.module.ts) beside the setup controllers and
services, exported and otherwise left alone.

**Submitting a run must refuse one that pays for hours nobody worked**
(rule R3, docs/plan/08 §1). Payroll does that itself, from its own data, with
the shared function in
[`src/common/paid-beyond-presence.ts`](../../common/paid-beyond-presence.ts):

```ts
const beyond = paidBeyondPresence(
  line.regularMinutes + line.overtimeMinutes,
  line.punchedMinutes,
  DEFAULT_PRESENCE_TOLERANCE_MINUTES,
);
if (beyond > 0) {
  throw new ConflictException(/* ... */);
}
```

**The gate uses the fixed default on purpose.** Detection's tolerance for R3
is a number an ADMIN can tune in the `detection_rules` table, but that table
is detection's, and payroll may not read it — so the two are allowed to
differ, and the difference is written down: the submission gate is the
**floor**, fixed at sixty minutes, and the sweep can be made stricter than it
but never looser in what it refuses. Widening the sweep's tolerance quietens
the alert queue; it never lets a run through that the gate would have stopped.

Never import anything from `modules/detection`. Detection reads payroll;
payroll never learns detection exists, and that is what keeps the two from
importing each other.

## What a run reads, and from where

Payroll owns no people and no punches, so calculating a month means asking:

| Question | Who answers it |
|---|---|
| Who is on the books, when were they employed, what were they scheduled? | `workforce/employees.service.ts`, `payrollFactsFor` |
| Which shifts were confirmed, on which dates? | `attendance/attendance-facts.service.ts`, `payableSegmentsByEmployee` |
| What is each person paid, and at what rates? | this module's own `employee_pay_terms` and `tax_tables` |

Both read seams are per **date**, not per month, because overtime is decided
day by day against that day's shift pattern. A month's total cannot tell you
whether somebody worked four short days and one very long one.

## Still to build

Submitting a run, approving it, rejecting it and marking it paid; the payslip
PDF; and the bank export. Then the dashboard screens. The contract for all of
them is already merged, inside the `# --- Payroll (Phase 4) ---` banners of
`packages/contracts/openapi.yaml`.

**Submitting must refuse a run that pays for hours nobody worked** — rule R3,
through `src/common/paid-beyond-presence.ts` with the fixed sixty-minute
floor, never by importing detection. The section below says why.
