/**
 * Every request the gateway makes to the API, signed with the terminal's own
 * secret. One rule, the same one the kiosk keeps: the body is serialised
 * once, that exact text is signed, and that exact text is sent.
 *
 * Failures are told apart, because each needs a different reaction:
 *
 * - a `401` is an **alarm** — this terminal's key is wrong or the device was
 *   switched off, and no retry fixes it;
 * - a `400` or `413` is a **rejection** — the API says this batch itself is
 *   malformed, and resending the same bytes forever would wedge every later
 *   punch behind it;
 * - anything else is an **outage** — worth retrying, with the status logged.
 */
import { type GatewayRoute, nowInSeconds, signRequest } from './signing.ts';

/** A site's internet can hang a socket open; the pump must not hang with it. */
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

export interface TerminalCredentials {
  /** The dashboard's device ID for this terminal (a ZKTECO device). */
  deviceId: string;
  /** The device secret, shown once when the device was registered. */
  secret: string;
}

/** The alarm case: the server said this terminal may not speak. */
export class TerminalNotTrusted extends Error {
  constructor(deviceId: string) {
    super(
      `The API refused device ${deviceId} (401). Its key is wrong, the device was switched ` +
        'off on the dashboard, or this computer’s clock is far off. This does not fix ' +
        'itself: an administrator checks the device on the dashboard and this machine’s clock.',
    );
    this.name = 'TerminalNotTrusted';
  }
}

/** The rejection case: this exact content will never be accepted. */
export class ApiRequestRejected extends Error {
  readonly status: number;

  constructor(status: number, route: string) {
    super(`The API rejected the content itself (${status}) on ${route}.`);
    this.name = 'ApiRequestRejected';
    this.status = status;
  }
}

/** Any other failed request: worth retrying, with the status for the log. */
export class ApiRequestFailed extends Error {
  readonly status: number;

  constructor(status: number, route: string) {
    super(`The API answered ${status} on ${route}.`);
    this.name = 'ApiRequestFailed';
    this.status = status;
  }
}

export class GatewayApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async call<Answer>(
    credentials: TerminalCredentials,
    route: GatewayRoute,
    body: unknown,
  ): Promise<Answer> {
    const text = JSON.stringify(body);
    const timestamp = nowInSeconds();
    const signature = signRequest(credentials.secret, timestamp, route, text);

    const response = await fetch(`${this.baseUrl}/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Samtec-Device': credentials.deviceId,
        'X-Samtec-Timestamp': timestamp,
        'X-Samtec-Signature': signature,
      },
      body: text,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });

    if (response.status === 401) {
      throw new TerminalNotTrusted(credentials.deviceId);
    }
    if (response.status === 400 || response.status === 413) {
      throw new ApiRequestRejected(response.status, route);
    }
    if (!response.ok) {
      throw new ApiRequestFailed(response.status, route);
    }
    if (response.status === 204) {
      return undefined as Answer;
    }
    // A captive portal or a proxy can answer 200 with anything at all; a
    // non-JSON body must read as an outage, never as a delivered batch.
    try {
      return (await response.json()) as Answer;
    } catch {
      throw new ApiRequestFailed(response.status, `${route} (unreadable body)`);
    }
  }
}
