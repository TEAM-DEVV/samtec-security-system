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
