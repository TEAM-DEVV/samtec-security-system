# company module

**Purpose:** the company's own record — its name, and the bank account its
payroll is paid from.

## Tables it owns

No table of its own. It owns four columns on `companies`
(`bank_name`, `branch`, `account_name`, `account_number`), added in the
`company_bank_account` migration. Nothing outside this module writes to them.

## Rules that must hold

- **The account number is never read back in full.** `GET /company/bank-account`
  and the payment receipt both see it masked to its last four digits only
  (`../../common/masking.ts`). It is never logged, never put in an error
  message, and never put in a URL.
- **Changing it needs a fresh password confirmation** (`@NeedsPassword()`),
  the same control that covers approving a payroll run. The contract marks the
  `PUT` `x-needs-password: true`, and `test/password-confirmation.e2e-spec.ts`
  fails CI if the two ever disagree.
- **The audit entry names which fields moved, never a value.** `detail` holds
  a comma-separated list of the field names that changed, the same shape
  `payroll/employee-pay.service.ts` uses for payment details.
- Replacing the account is a full replace, not a patch: `PUT` takes all four
  fields every time, with `null` for anything the company does not have, so a
  field is only ever cleared on purpose.

## The files

| File | What it is for |
|---|---|
| `company.module.ts` | The wiring |
| `company.controller.ts` | `/company/bank-account`: `GET` (ADMIN, HR_PAYROLL) and `PUT` (ADMIN) |
| `company.service.ts` | Reads and writes the four columns, masks the account number, and `payingAccountFor` — the read seam payroll uses for the payment receipt |
| `company.schemas.ts` | The one Zod input rule: `SetCompanyBankAccountRequest` |
