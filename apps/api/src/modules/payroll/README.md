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
  the endpoint that sets it and inside the bank export, and nowhere else.

## The files

| File | What it is for |
|---|---|
| `pay-calculation.ts` | The money, as a pure function: pro-rating, SSNIT, the graduated PAYE bands, net pay. No database, no `this` |
| `worked-minutes.ts` | Which shifts belong to the period, which minutes are overtime, and how many days somebody was employed. Also pure |
| `*.spec.ts` | The unit tests beside each one, including the eight hand-calculated payslips from the design page |

The rules the **database** enforces live in the migration
`20260924004536_phase_4_payroll`, and are proved against a real PostgreSQL by
[`test/payroll-rules.e2e-spec.ts`](../../../test/payroll-rules.e2e-spec.ts).

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
payroll touches the tables. It is already wired into
[`payroll.module.ts`](payroll.module.ts) — the controller and the payroll
service go in that same module when they land.

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

## Still to build

The endpoints, the payslip PDF (`pdfkit`), and the dashboard screens. The
contract for all of them is already merged, inside the
`# --- Payroll (Phase 4) ---` banners of `packages/contracts/openapi.yaml`.
