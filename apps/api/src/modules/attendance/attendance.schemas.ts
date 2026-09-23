import { z } from 'zod';

/**
 * The rules for every attendance input, matching the contract exactly.
 * `strictObject` rejects fields we did not ask for — a device can never slip
 * a template or an image into a punch.
 */

export const idSchema = z.uuid();

const cursor = z.string().min(1).max(200);
const limit = z.coerce.number().int().min(1).max(100).default(25);
/** An ISO 8601 moment that carries its UTC offset (`Z` or `+00:00`). */
const instant = z.iso.datetime({ offset: true });

// --- Devices ------------------------------------------------------------------

export const listDevicesQuerySchema = z.strictObject({ limit, cursor: cursor.optional() });
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;

const deviceName = z.string().min(2).max(60);

/** Contract: `RegisterDeviceRequest`. */
export const registerDeviceSchema = z.strictObject({
  name: deviceName,
  siteId: z.uuid(),
  kind: z.enum(['MOCK', 'ZKTECO', 'FACE_KIOSK']),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceSchema>;

/**
 * Contract: `UpdateDeviceRequest`. A device's site and kind are fixed for
 * life. Which kinds may have a serial number or fingerprints is a rule about
 * the device itself, checked by the service once the device is found.
 */
export const updateDeviceSchema = z
  .strictObject({
    name: deviceName.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    serialNumber: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'Use 1 to 64 letters, digits and dashes.')
      .nullable()
      .optional(),
    passkeysEnabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateDeviceBody = z.infer<typeof updateDeviceSchema>;

// --- Ingest -------------------------------------------------------------------

/**
 * Contract: `IngestPunchMethod`. Narrower than every punch method: the kiosk
 * methods (FACE_PASSKEY, STAFF_PASSKEY) are set only by the server, so a
 * terminal can never claim one.
 */
export const INGEST_PUNCH_METHODS = ['FINGERPRINT', 'FACE', 'PIN_FALLBACK'] as const;

/** Contract: `IngestPunch`. */
const ingestPunch = z.strictObject({
  deviceEventId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[!-~]+$/, 'Printable ASCII only, with no spaces.'),
  deviceUserRef: z.string().min(1).max(32),
  deviceTime: instant,
  direction: z.enum(['IN', 'OUT', 'UNKNOWN']),
  method: z.enum(INGEST_PUNCH_METHODS),
});
export type IngestPunchBody = z.infer<typeof ingestPunch>;

/** Contract: `IngestPunchesRequest`. At most 100 punches, each event ID once. */
export const ingestPunchesSchema = z
  .strictObject({
    deviceClockAt: instant.optional(),
    punches: z.array(ingestPunch).min(1).max(100),
  })
  .refine(
    (body) =>
      new Set(body.punches.map((punch) => punch.deviceEventId)).size === body.punches.length,
    { path: ['punches'], error: 'Each deviceEventId may appear only once in a batch.' },
  );
export type IngestPunchesBody = z.infer<typeof ingestPunchesSchema>;

/** Contract: `HeartbeatRequest`. */
export const heartbeatSchema = z.strictObject({ deviceClockAt: instant.optional() });
export type HeartbeatBody = z.infer<typeof heartbeatSchema>;

// --- Work segments and the exception queue ------------------------------------

/** A calendar date like 2026-09-15 that really exists on the calendar. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-09-15.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'This date does not exist on the calendar.');

const DAY_MS = 86_400_000;

/** Contract: `listWorkSegments`. At most 31 days, so one request never reads a year. */
export const listSegmentsQuerySchema = z
  .strictObject({
    from: calendarDate,
    to: calendarDate,
    siteId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    status: z.enum(['CONFIRMED', 'DISPUTED', 'VOIDED']).optional(),
    limit,
    cursor: cursor.optional(),
  })
  .refine(
    (query) => {
      const days = (Date.parse(query.to) - Date.parse(query.from)) / DAY_MS;
      return days >= 0 && days <= 31;
    },
    { path: ['to'], error: 'Must be on or after `from`, and at most 31 days later.' },
  );
export type ListSegmentsQuery = z.infer<typeof listSegmentsQuerySchema>;

/** Contract: `listAttendanceExceptions`. */
export const listExceptionsQuerySchema = z.strictObject({
  status: z.enum(['OPEN', 'RESOLVED', 'AUTO_CLOSED']).default('OPEN'),
  type: z
    .enum([
      'MISSING_CLOCK_OUT',
      'MISSING_CLOCK_IN',
      'UNKNOWN_EMPLOYEE',
      'INACTIVE_EMPLOYEE',
      'OVERLAP',
    ])
    .optional(),
  siteId: z.uuid().optional(),
  limit,
  cursor: cursor.optional(),
});
export type ListExceptionsQuery = z.infer<typeof listExceptionsQuerySchema>;

/** Contract: `ResolutionNote`. Shown to reviewers, never copied into the audit log. */
const note = z.string().trim().min(3).max(500);

/** Contract: `ResolveExceptionRequest`, one shape per action. */
export const resolveExceptionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('DISMISS'), note }),
  z.strictObject({
    action: z.literal('ADD_SEGMENT'),
    startedAt: instant,
    endedAt: instant,
    note,
  }),
  z.strictObject({ action: z.literal('KEEP_SEGMENT'), segmentId: z.uuid(), note }),
  z.strictObject({ action: z.literal('VOID_ALL'), note }),
]);
export type ResolveExceptionBody = z.infer<typeof resolveExceptionSchema>;

// --- Biometrics (Phase 3) -----------------------------------------------------

/** Contract: `RecordConsentRequest`. The 4 digits are read off the worker's own card. */
export const recordConsentSchema = z.strictObject({
  employeeId: z.uuid(),
  ghanaCardLast4: z.string().regex(/^[0-9]{4}$/),
  textVersion: z.string().min(1).max(32),
});
export type RecordConsentBody = z.infer<typeof recordConsentSchema>;

/** Contract: `FaceSample`. Numbers only: a kiosk can never send an image. */
const faceSample = z.strictObject({
  model: z.string().min(1).max(64),
  embedding: z.array(z.number()).length(1024),
  real: z.number().min(0).max(1),
  live: z.number().min(0).max(1),
});

/** Contract: `EnrollFaceRequest`. Three frames, half a second apart. */
export const enrollFaceSchema = z.strictObject({
  employeeId: z.uuid(),
  consentId: z.uuid(),
  samples: z.array(faceSample).length(3),
});
export type EnrollFaceBody = z.infer<typeof enrollFaceSchema>;

/** Contract: `BiometricReasonRequest`. Why a face was removed; kept with the audit record. */
export const biometricReasonSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});
export type BiometricReasonBody = z.infer<typeof biometricReasonSchema>;

/** Contract: `RequestExemptionRequest`. The code is enough: never write down religion or health. */
export const requestExemptionSchema = z.strictObject({
  reason: z.enum(['DECLINED', 'CANNOT_ENROLL']),
  note,
});
export type RequestExemptionBody = z.infer<typeof requestExemptionSchema>;

/** Contract: `ReviewExemptionRequest`. A second ADMIN decides, with a note. */
export const reviewExemptionSchema = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
  note,
});
export type ReviewExemptionBody = z.infer<typeof reviewExemptionSchema>;

/** Contract: `ResolveCollisionRequest`, one shape per verdict. */
export const resolveCollisionSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.literal('DIFFERENT_PEOPLE'), note }),
  z.strictObject({ verdict: z.literal('SAME_PERSON'), keepEmployeeId: z.uuid(), note }),
]);
export type ResolveCollisionBody = z.infer<typeof resolveCollisionSchema>;

/** Contract: the `listBiometricCollisions` query. Open reviews first, by default. */
export const listCollisionsQuerySchema = z.strictObject({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  limit,
  cursor: cursor.optional(),
});
export type ListCollisionsQuery = z.infer<typeof listCollisionsQuerySchema>;
