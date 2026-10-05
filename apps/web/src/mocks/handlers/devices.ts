import type {
  Device,
  DeviceList,
  DeviceWithSecret,
  RegisterDeviceRequest,
  UpdateDeviceRequest,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { mockDevices } from '../data/devices';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  conflict,
  forbidden,
  isOneOf,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  unauthorized,
  validationProblem,
} from '../helpers';
import { needsPassword, userForRequest } from './auth';
import { revokeMockPasskeysOn } from './biometrics';

/**
 * The mock device registry (ADMIN only, like the real API). It keeps its own
 * copy, so registering and changing devices works; tests call
 * `resetMockDevices()` to start fresh.
 */
let devices: Device[] = mockDevices.map((device) => ({ ...device }));

export function resetMockDevices(): void {
  devices = mockDevices.map((device) => ({ ...device }));
}

/**
 * Whether any device at this site is switched on. The Sites mock handler
 * asks this before letting a site go INACTIVE, the same rule the real API
 * enforces.
 */
export function hasActiveDeviceAtSite(siteId: string): boolean {
  return devices.some((device) => device.siteId === siteId && device.status === 'ACTIVE');
}

const KINDS = ['MOCK', 'ZKTECO', 'FACE_KIOSK'] as const;
const STATUSES = ['ACTIVE', 'INACTIVE'] as const;
const noStore = { 'Cache-Control': 'no-store' };

/** A fresh random secret, shaped like the real one (32 bytes, base64url). */
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** Signed in as ADMIN, or the 401/403 the real API would send. */
function adminOnly(request: Request) {
  const user = userForRequest(request);
  if (!user) return unauthorized('Sign in to continue.');
  if (user.role !== 'ADMIN') return forbidden();
  return undefined;
}

function findDevice(deviceId: string) {
  if (!isUuid(deviceId)) {
    return { problem: validationProblem('deviceId', 'Must be a valid ID.') };
  }
  const device = devices.find((candidate) => candidate.id === deviceId);
  return device ? { device } : { problem: notFound('No device exists with this ID.') };
}

function nameProblem(name: unknown) {
  return typeof name === 'string' && name.length >= 2 && name.length <= 60
    ? undefined
    : validationProblem('name', 'Must be 2 to 60 characters long.');
}

export const deviceHandlers = [
  http.get<PathParams, never, OrProblem<DeviceList>>(apiUrl('/devices'), ({ request }) => {
    const refused = adminOnly(request);
    if (refused) return refused;
    const query = new URL(request.url).searchParams;
    const limit = readLimit(query);
    if (limit === undefined) {
      return validationProblem('limit', 'Must be a whole number from 1 to 100.');
    }
    const siteId = query.get('siteId');
    if (siteId !== null && !isUuid(siteId)) {
      return validationProblem('siteId', 'Must be a valid ID.');
    }
    const sorted = devices
      .filter((device) => siteId === null || device.siteId === siteId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const page = pageOf(sorted, limit, query.get('cursor'));
    return page
      ? HttpResponse.json<DeviceList>(page)
      : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
  }),

  http.post<PathParams, RegisterDeviceRequest, OrProblem<DeviceWithSecret>>(
    apiUrl('/devices'),
    async ({ request }) => {
      const refused = adminOnly(request);
      if (refused) return refused;
      const unconfirmed = needsPassword(request);
      if (unconfirmed) return unconfirmed;
      const body = await request.json();
      const badName = nameProblem(body.name);
      if (badName) return badName;
      if (!isUuid(body.siteId ?? '') || !mockSites.some((site) => site.id === body.siteId)) {
        return validationProblem('siteId', 'No site exists with this ID.');
      }
      if (!isOneOf(KINDS, body.kind ?? '')) {
        return validationProblem('kind', `Must be one of ${KINDS.join(', ')}.`);
      }
      if (body.passkeysEnabled !== undefined && typeof body.passkeysEnabled !== 'boolean') {
        return validationProblem('passkeysEnabled', 'Must be true or false.');
      }
      // Only a kiosk has a fingerprint sensor of its own (same rule as changing it later).
      if (body.passkeysEnabled && body.kind !== 'FACE_KIOSK') {
        return validationProblem(
          'passkeysEnabled',
          'Only a face kiosk can use its own fingerprint sensor.',
        );
      }
      if (devices.some((device) => device.name === body.name)) {
        return conflict('A device with this name already exists.');
      }
      const now = new Date().toISOString();
      const device: Device = {
        id: crypto.randomUUID(),
        name: body.name,
        siteId: body.siteId,
        kind: body.kind,
        // Born switched off: an administrator switches it on from the
        // dashboard once it is really at the site.
        status: 'INACTIVE',
        lastSeenAt: null,
        lastClockDriftSeconds: null,
        failedSignatureCount: 0,
        lastFailedSignatureAt: null,
        serialNumber: null,
        // Left out, this defaults to off, same as before this field existed.
        passkeysEnabled: body.passkeysEnabled ?? false,
        createdAt: now,
        updatedAt: now,
      };
      devices.push(device);
      return HttpResponse.json<DeviceWithSecret>(
        { device, secret: newSecret() },
        { status: 201, headers: { Location: `/api/v1/devices/${device.id}`, ...noStore } },
      );
    },
  ),

  http.get<{ deviceId: string }, never, OrProblem<Device>>(
    apiUrl('/devices/:deviceId'),
    ({ params, request }) => {
      const refused = adminOnly(request);
      if (refused) return refused;
      const found = findDevice(params.deviceId);
      return found.device ? HttpResponse.json<Device>(found.device) : found.problem;
    },
  ),

  http.patch<{ deviceId: string }, UpdateDeviceRequest, OrProblem<Device>>(
    apiUrl('/devices/:deviceId'),
    async ({ params, request }) => {
      const refused = adminOnly(request);
      if (refused) return refused;
      const unconfirmed = needsPassword(request);
      if (unconfirmed) return unconfirmed;
      // The real API's order: the shape of the request (400), then the device
      // (404), then the rules for its kind (400), then clashes (409). A
      // refused request changes nothing.
      const body = await request.json();
      const { name, status, serialNumber, passkeysEnabled } = body;
      const fields = ['name', 'status', 'serialNumber', 'passkeysEnabled'];
      const unknown = Object.keys(body).find((key) => !fields.includes(key));
      if (!isUuid(params.deviceId)) return validationProblem('deviceId', 'Must be a valid ID.');
      if (unknown !== undefined) return validationProblem(unknown, 'Unrecognized field.');
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      const badName = name === undefined ? undefined : nameProblem(name);
      if (badName) return badName;
      if (status !== undefined && !isOneOf(STATUSES, status)) {
        return validationProblem('status', `Must be one of ${STATUSES.join(', ')}.`);
      }
      if (
        serialNumber !== undefined &&
        serialNumber !== null &&
        (typeof serialNumber !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(serialNumber))
      ) {
        return validationProblem(
          'serialNumber',
          'Use 1 to 64 letters, digits and dashes, or null.',
        );
      }
      if (passkeysEnabled !== undefined && typeof passkeysEnabled !== 'boolean') {
        return validationProblem('passkeysEnabled', 'Must be true or false.');
      }

      const found = findDevice(params.deviceId);
      if (!found.device) return found.problem;
      const device = found.device;
      // Only a ZKTeco terminal has a serial number, typed from its label.
      if (serialNumber && device.kind !== 'ZKTECO') {
        return validationProblem('serialNumber', 'Only a ZKTeco terminal has a serial number.');
      }
      // Only a kiosk has a fingerprint sensor of its own.
      if (passkeysEnabled && device.kind !== 'FACE_KIOSK') {
        return validationProblem(
          'passkeysEnabled',
          'Only a face kiosk can use its own fingerprint sensor.',
        );
      }
      if (
        name !== undefined &&
        devices.some((other) => other.name === name && other.id !== device.id)
      ) {
        return conflict('A device with this name already exists.');
      }
      if (
        serialNumber &&
        devices.some((other) => other.serialNumber === serialNumber && other.id !== device.id)
      ) {
        return conflict('Another device already has this serial number.');
      }

      if (name !== undefined) device.name = name;
      if (status !== undefined) device.status = status;
      if (serialNumber !== undefined) device.serialNumber = serialNumber;
      if (passkeysEnabled !== undefined) {
        // Switching fingerprints off revokes every key saved on this device.
        if (device.passkeysEnabled && !passkeysEnabled) revokeMockPasskeysOn(device.id);
        device.passkeysEnabled = passkeysEnabled;
      }
      device.updatedAt = new Date().toISOString();
      return HttpResponse.json<Device>(device);
    },
  ),

  http.post<{ deviceId: string }, never, OrProblem<DeviceWithSecret>>(
    apiUrl('/devices/:deviceId/rotate-secret'),
    ({ params, request }) => {
      const refused = adminOnly(request);
      if (refused) return refused;
      const unconfirmed = needsPassword(request);
      if (unconfirmed) return unconfirmed;
      const found = findDevice(params.deviceId);
      if (!found.device) return found.problem;
      // A new key is a new key: the device waits to be switched on again.
      found.device.status = 'INACTIVE';
      found.device.updatedAt = new Date().toISOString();
      return HttpResponse.json<DeviceWithSecret>(
        { device: found.device, secret: newSecret() },
        { headers: noStore },
      );
    },
  ),
];
