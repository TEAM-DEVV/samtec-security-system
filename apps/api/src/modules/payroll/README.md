# payroll module (Phase 4)

**Purpose:** correct Ghanaian pay calculated from verified attendance.

**Will own these tables:** `payroll_periods`, `payroll_runs`, `payroll_lines`, `tax_tables`, `payslips`.

## Rules that must hold

- Money is always an integer number of pesewas. Never use decimals for money.
- A payroll run copies every input it used (rates, hours, allowances, tax) into its lines, so history never changes.
- A locked run can never be edited. A database trigger rejects changes. Corrections go into the next run as adjustment lines.
- The person who prepares a run cannot approve it (maker–checker), enforced in the service, not only in the UI.
- PAYE bands and SSNIT rates come from versioned `tax_tables` rows, never from numbers written in the code.
- The calculation has golden tests with hand-checked payslips, correct to the pesewa.

Details: `docs/plan/09-payroll-engine-ghana.md`.
