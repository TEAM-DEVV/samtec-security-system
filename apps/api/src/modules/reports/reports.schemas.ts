/**
 * Every Zod input rule for the reports module.
 *
 * Contract: the `Reports` operations in `packages/contracts/openapi.yaml`.
 * `strictObject` throughout, so a query parameter nobody expected is a clear
 * 400 naming it rather than a filter that silently did nothing.
 */
import { z } from 'zod';

/** A calendar date, never a timestamp, and one that exists on the calendar. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-09-15.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'This date does not exist on the calendar.');

/** Contract: the query of `downloadAttendanceReport`. */
export const attendanceReportQuerySchema = z.strictObject({
  from: calendarDate,
  to: calendarDate,
  siteId: z.uuid().optional(),
});
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

/** A site's ID, as every other module's controller validates one. */
export const idSchema = z.uuid();

/** Contract: the `month` path parameter of `downloadSiteInvoicePdf`. */
export const invoiceMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month like 2026-09.');
export type InvoiceMonth = z.infer<typeof invoiceMonthSchema>;

/**
 * Contract: the query of `downloadSiteInvoicePdf`. There is no saved rate
 * yet, so it is sent with every request. The cap matches the one every
 * payroll money field already uses (`payroll.schemas.ts`), far above any
 * real hourly rate but comfortably inside the database's `INTEGER` column.
 */
export const siteInvoiceQuerySchema = z.strictObject({
  hourlyRatePesewas: z.coerce.number().int().min(1).max(100_000_000),
});
export type SiteInvoiceQuery = z.infer<typeof siteInvoiceQuerySchema>;
