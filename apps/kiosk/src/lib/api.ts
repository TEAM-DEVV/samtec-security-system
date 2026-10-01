import type { ProblemDetails } from '@samtec/contracts';
import type { PairedDevice } from '@/lib/device';
import { type KioskRoute, nowInSeconds, signRequest } from '@/lib/signing';

/**
 * Every request this kiosk makes.
 *
 * There is one rule and the whole file exists to keep it: the body is
 * serialised **once**, that exact text is signed, and that exact text is sent.
 * Serialising twice would put a different space somewhere and the server would
 * refuse everything, with a 401 that says nothing about why.
 */

/**
 * Where the API is.
 *
 * `VITE_API_BASE_URL`, the same name the dashboard uses, so one setting means
 * one thing across the project. It defaults to `/api/v1` — a path, not a host —
 * so both the dev server and the deployment reach the API on this app's **own
 * origin**: the dev server proxies it (`vite.config.ts`) and Vercel rewrites it
 * (`vercel.json`).
 *
 * Same-origin is not a convenience here. The kiosk's content security policy
 * sets `connect-src 'self'`, and WebAuthn keys are bound to an origin, so a
 * cross-origin API would break the fingerprint path and be blocked by the
 * policy. A trailing slash is trimmed so a URL never reads `/api/v1//kiosk/…`.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/+$/, '');

/** A hung connection must not hold a guard at the gate with the camera on. */
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

/** A refusal the kiosk can show a person, with the API's own words. */
export class KioskRequestFailed extends Error {
  readonly status: number;
  readonly traceId: string | undefined;

  constructor(status: number, message: string, traceId?: string) {
    super(message);
    this.name = 'KioskRequestFailed';
    this.status = status;
    this.traceId = traceId;
  }
}

/** True for anything shaped like the API's error format. */
function isProblem(value: unknown): value is ProblemDetails {
  return typeof value === 'object' && value !== null && 'title' in value && 'status' in value;
}

/**
 * Calls one signed kiosk route.
 *
 * `route` is the route *name*, which is both what gets signed and what builds
 * the URL — so the two can never disagree.
 */
export async function callSigned<Answer>(
  device: PairedDevice,
  route: KioskRoute,
  body: unknown,
  /**
   * An administrator's access token, for the set-up routes only.
   *
   * Consent, enrollment and saving a finger need **both** an ADMIN signed in on
   * this kiosk and the device's signature: a stolen password alone cannot enroll
   * anybody, and neither can a stolen kiosk (docs/plan/13 section 2). The
   * everyday clock-in routes pass nothing here — the guard at the gate has no
   * account.
   */
  adminToken?: string,
): Promise<Answer> {
  // Once. Everything below uses this exact string.
  const text = JSON.stringify(body);
  const timestamp = nowInSeconds();
  const signature = await signRequest(device.key, timestamp, route, text);

  const response = await fetch(`${BASE_URL}/${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Samtec-Device': device.deviceId,
      'X-Samtec-Timestamp': timestamp,
      'X-Samtec-Signature': signature,
      ...(adminToken === undefined ? {} : { Authorization: `Bearer ${adminToken}` }),
    },
    body: text,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });

  if (response.status === 204) {
    return undefined as Answer;
  }

  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // `detail` is optional in the contract, so there is always a fallback.
    throw new KioskRequestFailed(
      response.status,
      messageFor(response.status, answer),
      isProblem(answer) ? answer.traceId : undefined,
    );
  }
  return answer as Answer;
}

/**
 * What an administrator can check when the server refuses this kiosk. The
 * server answers every device failure with one sentence on purpose (a wrong
 * secret, a device switched off, a device of the wrong kind all read the
 * same), so the kiosk has to name the two things a person can actually fix.
 */
export const KIOSK_REFUSED =
  'The system refused this kiosk. On the dashboard, under Devices, check that this device is switched on and that its kind is Face kiosk. Then set this phone up again with its Device ID and secret.';

/**
 * The words a refusal shows: a field's own message first (the digits of a
 * Ghana Card, for one), then the server's detail, then a plain fallback.
 */
function messageFor(status: number, answer: unknown): string {
  if (status === 401) {
    return KIOSK_REFUSED;
  }
  if (isProblem(answer)) {
    const field = (answer as { errors?: { message?: unknown }[] }).errors?.[0]?.message;
    if (typeof field === 'string' && field.length > 0) {
      return field;
    }
    if (answer.detail) {
      return answer.detail;
    }
  }
  return refusalFor(status);
}

/**
 * What to say when the server sent no words of its own.
 *
 * Never a score and never a name: anyone can stand in front of a kiosk, so a
 * refusal must not teach a stranger anything about who works here.
 */
function refusalFor(status: number): string {
  switch (status) {
    case 401:
      return 'This kiosk is not signed in to the system. Ask an administrator.';
    case 429:
      return 'Too many tries. Wait a moment and start again.';
    case 503:
      return 'The system is busy. Try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
