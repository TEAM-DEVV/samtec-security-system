/**
 * Every Zod input rule for the payroll module, in one file.
 *
 * Contract: the `Payroll` operations in `packages/contracts/openapi.yaml`.
 * Each schema mirrors one request schema or one set of query parameters, and
 * the limits here are the limits written there — where they differ, the
 * contract wins and this file is wrong.
 *
 * Everything is `z.strictObject`, never `z.object`, so a field nobody expected
 * is a clear 400 naming it rather than a value silently thrown away. That
 * matters more here than anywhere else in the API: a mistyped money field that
 * is quietly ignored would pay somebody the wrong amount.
 */
import { z } from 'zod';
import { bandShapeProblem } from './tax-band-shape.js';

/** Any record is addressed by its UUID. */
export const idSchema = z.uuid();

/** The shared list controls, as `Cursor` and `Limit` in the contract. */
const limit = z.coerce.number().int().min(1).max(100).default(25);
const cursor = z.string().min(1).max(200);

/**
 * A calendar date, never a timestamp: `YYYY-MM-DD`, and one that really exists
 * on the calendar. The same definition as `workforce.schemas.ts` uses, because
 * a date the two modules disagree about would be worse than a little repetition.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-09-15.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'This date does not exist on the calendar.');

/**
 * The cap is GHS 1,000,000 a month for one person — far above any real salary,
 * and low enough that the four amounts added together on a payroll line still
 * fit the `INTEGER` column that holds the total. The database refuses anything
 * above it as well.
 */
const moneyPesewas = z.number().int().min(0).max(100_000_000);

/**
 * Whether a value holds anything invisible: a tab, a line break, or any
 * other control character.
 *
 * A tab or a line break in a bank file forges an extra row. A NUL byte does
 * something worse and quieter — PostgreSQL cannot store one in a text column
 * at all, so it would come back as a 500 from deep in the driver rather than
 * as an answer naming the field.
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

/** Nothing a spreadsheet would run as a formula when it opens the bank file. */
const SAFE_FIRST_CHARACTER = /^[^=+@\s"-]/;

/** Hundredths of a percent, so 550 is 5.5%. */
const basisPoints = z.number().int().min(0).max(10_000);

/** A tax year, wide enough for history and for planning ahead. */
const taxYear = z.number().int().min(2020).max(2100);

/**
 * Refuses a date that has not happened yet.
 *
 * Both places this is used record something that is already true — the day a
 * payroll was paid, and the day somebody checked the tax rates against the
 * published source — so a date in the future is either a typing mistake or an
 * attempt to make a record look older than it is.
 */
const notInTheFuture = (what: string) =>
  calendarDate.refine(
    (value) => value <= new Date().toISOString().slice(0, 10),
    `${what} cannot be in the future.`,
  );

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** Contract: the query of `listPayrollPeriods`. */
export const listPeriodsQuerySchema = z.strictObject({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListPeriodsQuery = z.infer<typeof listPeriodsQuerySchema>;

/** Contract: `CreatePayrollPeriodRequest`. The API works out the two dates. */
export const createPeriodSchema = z.strictObject({
  year: taxYear,
  month: z.number().int().min(1).max(12),
});
export type CreatePeriodBody = z.infer<typeof createPeriodSchema>;

// ---------------------------------------------------------------------------
// Runs and their lines
// ---------------------------------------------------------------------------

/** Contract: the query of `listPayrollRuns`. */
export const listRunsQuerySchema = z.strictObject({
  periodId: idSchema.optional(),
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'LOCKED', 'PAID', 'REJECTED']).optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

/**
 * Contract: `CreatePayrollRunRequest`. Only the period is sent: everything else
 * is read from the company's own records, because a run that took its figures
 * from the request would be a run somebody could dictate.
 */
export const createRunSchema = z.strictObject({
  periodId: idSchema,
});
export type CreateRunBody = z.infer<typeof createRunSchema>;

/** Contract: the query of `listPayrollLines`. */
export const listLinesQuerySchema = z.strictObject({
  employeeId: idSchema.optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListLinesQuery = z.infer<typeof listLinesQuerySchema>;

/**
 * Contract: `ResolutionNote`. A short explanation of a decision.
 *
 * It is never copied into the audit log. The log records that somebody decided
 * and when, and the note stays on the run where the people involved can read
 * it — a note may well name a worker or a mistake, and the log is append-only
 * evidence that nobody can ever edit.
 */
const note = z.string().trim().min(3).max(500);

/** Contract: `SubmitPayrollRunRequest`. An empty body is valid. */
export const submitRunSchema = z.strictObject({ note: note.optional() });
export type SubmitRunBody = z.infer<typeof submitRunSchema>;

/** Contract: `ApprovePayrollRunRequest`. An empty body is valid. */
export const approveRunSchema = z.strictObject({ note: note.optional() });
export type ApproveRunBody = z.infer<typeof approveRunSchema>;

/**
 * Contract: `RejectPayrollRunRequest`. The reason is required, because a
 * rejection is final and whoever calculated the run has to know what to change.
 */
export const rejectRunSchema = z.strictObject({ reason: note });
export type RejectRunBody = z.infer<typeof rejectRunSchema>;

/** Contract: `MarkPayrollRunPaidRequest`. */
export const markPaidSchema = z.strictObject({
  paidOn: notInTheFuture('The day the money left'),
  paymentReference: z.string().trim().min(1).max(100).optional(),
  note: note.optional(),
});
export type MarkPaidBody = z.infer<typeof markPaidSchema>;

/** Contract: the query of `listPayslips`. */
export const listPayslipsQuerySchema = z.strictObject({
  employeeId: idSchema.optional(),
  periodId: idSchema.optional(),
  runId: idSchema.optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListPayslipsQuery = z.infer<typeof listPayslipsQuerySchema>;

// ---------------------------------------------------------------------------
// Tax tables
// ---------------------------------------------------------------------------

/** Contract: the query of `listTaxTables`. */
export const listTaxTablesQuerySchema = z.strictObject({
  taxYear: z.coerce.number().int().min(2020).max(2100).optional(),
  effectiveOn: calendarDate.optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListTaxTablesQuery = z.infer<typeof listTaxTablesQuerySchema>;

/** Contract: `TaxBand`. `widthPesewas` is null only on the last band. */
const taxBandSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(20),
  widthPesewas: z.number().int().min(1).max(100_000_000).nullable(),
  rateBasisPoints: basisPoints,
});

/**
 * Contract: `CreateTaxTableRequest`.
 *
 * The two cross-field rules are checked here rather than in the service,
 * because both are about the request itself and both should name the field
 * that is wrong. The band shape is the important one: it is what stops a table
 * being stored that would leave the highest earners untaxed.
 */
export const createTaxTableSchema = z
  .strictObject({
    taxYear,
    effectiveFrom: calendarDate,
    effectiveTo: calendarDate.nullable().optional(),
    ssnitEmployeeBasisPoints: basisPoints,
    ssnitEmployerBasisPoints: basisPoints,
    ssnitTier1BasisPoints: basisPoints,
    ssnitTier2BasisPoints: basisPoints,
    bands: z.array(taxBandSchema).min(1).max(20),
    sourceName: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .refine((value) => !hasControlCharacter(value), 'This may not contain a control character.'),
    sourceUrl: z.url().max(500),
    sourceCheckedOn: notInTheFuture('The day the rates were checked'),
  })
  .superRefine((table, context) => {
    if (
      table.effectiveTo !== null &&
      table.effectiveTo !== undefined &&
      table.effectiveTo < table.effectiveFrom
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'A version of the rates cannot stop before it starts.',
      });
    }

    // The band shape, in the words of whatever is actually wrong with it.
    const problem = bandShapeProblem(table.bands);
    if (problem !== null) {
      context.addIssue({ code: 'custom', path: ['bands'], message: problem });
    }

    // The two tiers are a split of one contribution, not two separate charges.
    // The engine refuses a table where they disagree, because it derives Tier 2
    // from the other three so the statutory summary always reconciles.
    if (
      table.ssnitTier1BasisPoints + table.ssnitTier2BasisPoints !==
      table.ssnitEmployeeBasisPoints + table.ssnitEmployerBasisPoints
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ssnitTier2BasisPoints'],
        message:
          'Tier 1 and Tier 2 together must equal the employee and employer shares together, because the tiers are a split of the same contribution.',
      });
    }
  });
export type CreateTaxTableBody = z.infer<typeof createTaxTableSchema>;

// ---------------------------------------------------------------------------
// Pay terms and payment details
// ---------------------------------------------------------------------------

/** Contract: the query of `listEmployeePayTerms`. */
export const listPayTermsQuerySchema = z.strictObject({
  effectiveOn: calendarDate.optional(),
  cursor: cursor.optional(),
  limit,
});
export type ListPayTermsQuery = z.infer<typeof listPayTermsQuerySchema>;

/**
 * Contract: `SetEmployeePayTermsRequest`. Every field is required, because the
 * new row states the whole of the worker's pay from that day: nothing is
 * carried over from the row before it, so a field left out would silently
 * become zero rather than staying as it was.
 */
export const setPayTermsSchema = z.strictObject({
  effectiveFrom: calendarDate,
  basicMonthlyPesewas: moneyPesewas,
  overtimeHourlyPesewas: moneyPesewas,
  taxableAllowancePesewas: moneyPesewas,
  nonTaxableAllowancePesewas: moneyPesewas,
  otherDeductionPesewas: moneyPesewas,
});
export type SetPayTermsBody = z.infer<typeof setPayTermsSchema>;

/**
 * A value that is written into the bank file.
 *
 * **There is deliberately no `.trim()` here.** Zod runs its checks in the
 * order they are written, so trimming first would quietly strip the very
 * leading space the pattern below exists to refuse — and the contract, the
 * dashboard mock and the database `CHECK` all test the raw value, so the API
 * would have been the one place that accepted what everything else refused.
 * A leading space matters because a spreadsheet trims it away on import and
 * then runs whatever was hiding behind it (decision 23).
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

/** Contract: `SetEmployeePaymentDetailsRequest`. Send `null` for anything absent. */
export const setPaymentDetailsSchema = z.strictObject({
  bankName: bankText.nullable(),
  accountName: bankText.nullable(),
  accountNumber: z
    .string()
    .regex(/^[0-9]{5,20}$/, 'An account number is 5 to 20 digits.')
    .nullable(),
  momoNumber: z
    .string()
    .regex(/^\+233\d{9}$/, 'A mobile money number looks like +233241234567.')
    .nullable(),
});
export type SetPaymentDetailsBody = z.infer<typeof setPaymentDetailsSchema>;
