# 09 · Payroll engine (Ghana)

Money is integers (pesewas). Payroll runs are locked snapshots. Approval needs a maker and a different checker. Statutory rates live in a **versioned tax table**, not in the code: rates change with every national budget, so we update a row instead of deploying new code.

## Calculation pipeline (per employee, per period)

```
attendance hours (regular and overtime, from work segments only)
 → gross pay = basic + overtime (at the contract's rate) + allowances (taxable or not)
 → SSNIT employee contribution: 5.5% of basic (the employer's 13% is a company cost, not a deduction)
 → taxable income = taxable gross − employee SSNIT
 → PAYE from the graduated monthly bands (table below)
 → net pay = gross − SSNIT (5.5%) − PAYE − other deductions (loans, uniforms and so on)
 → payroll line: every input copied into the line
```

## Statutory tables (seed values)

**Verify these against official GRA and SSNIT publications before the client pilot.** Each tax table row stores its source and date.

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

**SSNIT:** employee 5.5% plus employer 13%, a total of 18.5% of basic salary. SSNIT keeps 13.5% for Tier 1, and 5% goes to the employee's Tier 2 fund. Version 1 calculates and reports these amounts; paying them to SSNIT stays manual.

The 2026 figures above came from online calculators and guides during planning, which is exactly why they must be checked against the official GRA publication in Phase 4. Selecting a tax year is itself a feature that impresses both the examiner and the client.

## Hard rules

1. A run is calculated **only** from work segments and the contract data visible at calculation time. Everything is copied into its lines.
2. A LOCKED run cannot change: a database trigger rejects it. Corrections become signed adjustment lines in the next period, pointing to the original line.
3. The maker (who creates and submits) is never the checker (who approves). The server compares user IDs.
4. Detection rule R3 runs when a run is submitted. Unexplained differences between paid hours and punched hours block submission.
5. Rounding happens once, half-up, at the final pesewa. A property-based test proves that the lines always add up exactly to the run totals.
6. Payslip PDFs are generated once, when the run locks, and stored. What was sent is exactly what exists.

## Outputs

- Payslip PDF for each guard, which guards can download themselves
- Bank and mobile money CSV export
- Monthly PAYE and SSNIT summary reports
- Payroll cost trend data for the dashboard

## Test strategy

The payroll engine gets the highest test coverage in the repository. Golden files contain hand-calculated guards: below the tax-free threshold, mid-band, overtime-heavy, joined mid-month, left mid-month, and a night shift that crosses the period boundary. The engine must match each one to the pesewa.

Related: [Data model](04-data-model.md) · [Ghost detection engine](08-ghost-detection-engine.md)
