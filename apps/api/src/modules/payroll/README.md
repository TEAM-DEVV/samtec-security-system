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
- **A locked run never changes**, and nothing in payroll is ever deleted.
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

## Still to build

The endpoints, the payslip PDF (`pdfkit`), and the dashboard screens. The
contract for all of them is already merged, inside the
`# --- Payroll (Phase 4) ---` banners of `packages/contracts/openapi.yaml`.
