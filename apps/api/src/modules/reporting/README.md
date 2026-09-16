# reporting module (Phase 6)

**Purpose:** summaries and exports for management: attendance, payroll cost and detection results.

**Owns no business tables.** It only reads, through the other modules' services.

## Rules that must hold

- Reports never write to business tables.
- Reports apply the same role and site restrictions as the data they summarise.
- Exports (CSV, PDF) never include biometric data, and include Ghana Card numbers only for roles that need them.
