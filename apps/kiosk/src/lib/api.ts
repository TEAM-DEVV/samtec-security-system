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

/** Where the API is. Set at build time; the dev server proxies to localhost. */
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

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
    },
    body: text,
  });

  if (response.status === 204) {
    return undefined as Answer;
  }

  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // `detail` is optional in the contract, so there is always a fallback.
    throw new KioskRequestFailed(
      response.status,
      (isProblem(answer) ? answer.detail : undefined) ?? refusalFor(response.status),
      isProblem(answer) ? answer.traceId : undefined,
    );
  }
  return answer as Answer;
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
