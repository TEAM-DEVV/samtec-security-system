import { z } from 'zod';

/**
 * The rules for every workforce input, matching the contract exactly.
 * `strictObject` rejects fields we did not ask for, so a typo like `?stauts=`
 * — or an attempt to sneak in `ghanaCardNumber` on an update — becomes a
 * clear 400 instead of being silently ignored.
 */

export const idSchema = z.uuid();

const cursor = z.string().min(1).max(200);
const limit = z.coerce.number().int().min(1).max(100).default(25);

/** A calendar date like 2026-09-15 that really exists on the calendar. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-09-15.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'This date does not exist on the calendar.');

const personName = z.string().min(1).max(60);
const ghanaPhone = z.string().regex(/^\+233\d{9}$/, 'Must look like +233241234567.');
const ghanaCard = z.string().regex(/^GHA-\d{9}-\d$/, 'Must look like GHA-123456789-0.');
const position = z.string().min(2).max(60);
const email = z.email().max(254);

export const employeeStatusValues = [
  'PENDING_ENROLLMENT',
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED',
] as const;

export const terminationReasonValues = [
  'RESIGNED',
  'DISMISSED',
  'CONTRACT_ENDED',
  'ABSCONDED',
  'DECEASED',
  'OTHER',
] as const;

export const listEmployeesQuerySchema = z.strictObject({
  limit,
  cursor: cursor.optional(),
  status: z.enum(employeeStatusValues).optional(),
  siteId: z.uuid().optional(),
  search: z.string().min(2).max(100).optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

/** Contract: `CreateEmployeeRequest`. The API generates the staff number. */
export const createEmployeeSchema = z.strictObject({
  firstName: personName,
  lastName: personName,
  otherNames: personName.optional(),
  phone: ghanaPhone,
  email: email.optional(),
  ghanaCardNumber: ghanaCard,
  position,
  hireDate: calendarDate,
  siteId: z.uuid().optional(),
});
export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;

/**
 * Contract: `UpdateEmployeeRequest`. Only sent fields change; `null` clears
 * an optional field. The Ghana Card number is deliberately absent: identity
 * corrections need a separate, audited admin process, so they cannot be used
 * to hide a ghost worker.
 */
export const updateEmployeeSchema = z
  .strictObject({
    firstName: personName.optional(),
    lastName: personName.optional(),
    otherNames: personName.nullable().optional(),
    phone: ghanaPhone.optional(),
    email: email.nullable().optional(),
    position: position.optional(),
    siteId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateEmployeeBody = z.infer<typeof updateEmployeeSchema>;

/** Contract: `TerminateEmployeeRequest`. */
export const terminateEmployeeSchema = z
  .strictObject({
    effectiveDate: calendarDate,
    reason: z.enum(terminationReasonValues),
    note: z.string().min(1).max(500).optional(),
  })
  .refine((body) => body.reason !== 'OTHER' || body.note !== undefined, {
    path: ['note'],
    error: 'Explain the reason in `note` when the reason is OTHER.',
  });
export type TerminateEmployeeBody = z.infer<typeof terminateEmployeeSchema>;

export const listSitesQuerySchema = z.strictObject({
  limit,
  cursor: cursor.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  region: z
    .enum([
      'AHAFO',
      'ASHANTI',
      'BONO',
      'BONO_EAST',
      'CENTRAL',
      'EASTERN',
      'GREATER_ACCRA',
      'NORTH_EAST',
      'NORTHERN',
      'OTI',
      'SAVANNAH',
      'UPPER_EAST',
      'UPPER_WEST',
      'VOLTA',
      'WESTERN',
      'WESTERN_NORTH',
    ])
    .optional(),
});
export type ListSitesQuery = z.infer<typeof listSitesQuerySchema>;

/** Turns a checked calendar date into the Date the database stores (midnight UTC). */
export function toDatabaseDate(calendarDateText: string): Date {
  return new Date(`${calendarDateText}T00:00:00Z`);
}
