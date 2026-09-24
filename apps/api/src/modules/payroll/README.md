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
| `payroll.controller.ts` | `/payroll/periods` and `/payroll/tax-tables`. HTTP only, one method per contract operation |
| `employee-pay.controller.ts` | `/employees/{id}/pay-terms` and `/payment-details`. They hang off a person, but the data is payroll's |
| `payroll.schemas.ts` | Every Zod input rule for the module, in one file. Always `strictObject` |
| `payroll-periods.service.ts` | Opening a month, listing months, closing one for good |
| `tax-tables.service.ts` | The statutory rates, as versions that are never edited |
| `employee-pay.service.ts` | Pay history (append-only) and payment details (edited in place) |
| `payroll-mapping.ts` | Database rows to contract shapes, as pure functions |
| `pay-calculation.ts` | The money, as a pure function: pro-rating, SSNIT, the graduated PAYE bands, net pay. No database, no `this` |
| `worked-minutes.ts` | Which shifts belong to the period, which minutes are overtime, and how many days somebody was employed. Also pure |
| `tax-band-shape.ts` | Whether a set of PAYE bands covers every income, so a bad one is a clear 400 and not a trigger error |
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

## Still to build

The runs themselves — calculating a draft, submitting, approving, rejecting and
marking paid — the payslip PDF (`pdfkit`), the bank export, the statutory
summary, and the dashboard screens. The contract for all of them is already
merged, inside the `# --- Payroll (Phase 4) ---` banners of
`packages/contracts/openapi.yaml`.
