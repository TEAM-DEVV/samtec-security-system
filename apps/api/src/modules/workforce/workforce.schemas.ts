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
export const createEmployeeSchema = z
  .strictObject({
    firstName: personName,
    lastName: personName,
    otherNames: personName.optional(),
    phone: ghanaPhone,
    email: email.optional(),
    ghanaCardNumber: ghanaCard,
    position,
    hireDate: calendarDate,
    siteId: z.uuid().optional(),
    postId: z.uuid().optional(),
    shiftPatternId: z.uuid().optional(),
  })
  // A post or shift only makes sense as part of a posting, which needs the site.
  .refine((body) => body.postId === undefined || body.siteId !== undefined, {
    path: ['postId'],
    error: 'Send `siteId` too — a post belongs to a site.',
  })
  .refine((body) => body.shiftPatternId === undefined || body.siteId !== undefined, {
    path: ['shiftPatternId'],
    error: 'Send `siteId` too — a shift is worked at a site.',
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
    postId: z.uuid().nullable().optional(),
    shiftPatternId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.')
  // A post or shift only makes sense as part of a posting, which needs the site.
  .refine((body) => body.postId == null || (body.siteId !== undefined && body.siteId !== null), {
    path: ['postId'],
    error: 'Send a real `siteId` too — a post belongs to a site.',
  })
  .refine(
    (body) => body.shiftPatternId == null || (body.siteId !== undefined && body.siteId !== null),
    {
      path: ['shiftPatternId'],
      error: 'Send a real `siteId` too — a shift is worked at a site.',
    },
  );
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

/** A time of day like 18:30, in 24-hour form. */
const shiftTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time like 06:00 or 18:30.');

const rosterName = z.string().min(2).max(60);

export const listRosterQuerySchema = z.strictObject({
  limit,
  cursor: cursor.optional(),
});
export type ListRosterQuery = z.infer<typeof listRosterQuerySchema>;

/** Contract: `CreatePostRequest`. */
export const createPostSchema = z.strictObject({
  name: rosterName,
  requiredGuards: z.number().int().min(1).max(50).default(1),
});
export type CreatePostBody = z.infer<typeof createPostSchema>;

/** Contract: `UpdatePostRequest`. */
export const updatePostSchema = z
  .strictObject({
    name: rosterName.optional(),
    requiredGuards: z.number().int().min(1).max(50).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdatePostBody = z.infer<typeof updatePostSchema>;

/** Contract: `CreateShiftPatternRequest`. */
export const createShiftPatternSchema = z
  .strictObject({
    name: rosterName,
    startTime: shiftTime,
    endTime: shiftTime,
  })
  // Equal times would be a zero-length shift — always a typo.
  .refine((body) => body.startTime !== body.endTime, {
    path: ['endTime'],
    error: 'The end time cannot equal the start time.',
  });
export type CreateShiftPatternBody = z.infer<typeof createShiftPatternSchema>;

/** Contract: `UpdateShiftPatternRequest`. */
export const updateShiftPatternSchema = z
  .strictObject({
    name: rosterName.optional(),
    startTime: shiftTime.optional(),
    endTime: shiftTime.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateShiftPatternBody = z.infer<typeof updateShiftPatternSchema>;

/** Turns a checked calendar date into the Date the database stores (midnight UTC). */
export function toDatabaseDate(calendarDateText: string): Date {
  return new Date(`${calendarDateText}T00:00:00Z`);
}

/** "18:30" → 1110, the minutes-from-midnight number the database stores. */
export function toMinutes(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** 1110 → "18:30", for responses. */
export function toShiftTime(minutesFromMidnight: number): string {
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
