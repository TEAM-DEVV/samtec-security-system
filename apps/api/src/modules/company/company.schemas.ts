/**
 * Every Zod input rule for the company module.
 *
 * Contract: the `Company` operations in `packages/contracts/openapi.yaml`.
 * `z.strictObject`, never `z.object`, so a field nobody expected is a clear
 * 400 naming it rather than a value silently thrown away.
 */
import { z } from 'zod';

/**
 * Whether a value holds anything invisible: a tab, a line break, or any other
 * control character. The same check `payroll.schemas.ts` makes on its own
 * bank fields — duplicated rather than imported, so this module does not
 * reach into payroll's for a validation rule.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Nothing a spreadsheet would run as a formula, if this value is ever exported one day. */
const SAFE_FIRST_CHARACTER = /^[^=+@\s"-]/;

/**
 * A bank field: the bank's name, its branch, or the name on the account.
 *
 * **Deliberately no `.trim()`**, for the same reason `payroll.schemas.ts`
 * gives: trimming first would quietly strip the leading space the pattern
 * below exists to refuse.
 */
const bankText = z
  .string()
  .min(2)
  .max(100)
  .refine(
    (value) => !hasControlCharacter(value),
    'This may not contain a tab, a line break or any other invisible control character.',
  )
  .regex(
    SAFE_FIRST_CHARACTER,
    'This may not start with a space, a quote, or any of = + - @, because a spreadsheet would read it as a formula.',
  );

/** Contract: `SetCompanyBankAccountRequest`. Send `null` for anything the company does not have. */
export const setBankAccountSchema = z.strictObject({
  bankName: bankText.nullable(),
  branch: bankText.nullable(),
  accountName: bankText.nullable(),
  accountNumber: z
    .string()
    .regex(/^[0-9]{5,20}$/, 'An account number is 5 to 20 digits.')
    .nullable(),
});
export type SetBankAccountBody = z.infer<typeof setBankAccountSchema>;
