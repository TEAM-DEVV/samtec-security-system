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

/** Contract: `UpdateDeviceRequest`. A device's site is fixed for life. */
export const updateDeviceSchema = z
  .strictObject({
    name: deviceName.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateDeviceBody = z.infer<typeof updateDeviceSchema>;

// --- Ingest -------------------------------------------------------------------

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
  method: z.enum(['FINGERPRINT', 'FACE', 'PIN_FALLBACK']),
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
