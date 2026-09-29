/**
 * Every request the gateway makes to the API, signed with the terminal's own
 * secret. One rule, the same one the kiosk keeps: the body is serialised
 * once, that exact text is signed, and that exact text is sent.
 *
 * A `401` is not an outage: it means this terminal's key is wrong or the
 * device was switched off on the dashboard, and no retry will fix it. The
 * caller raises the alarm instead of retrying (docs/plan/13 section 5).
 */
import { type GatewayRoute, nowInSeconds, signRequest } from './signing.ts';

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
      `The API refused device ${deviceId} (401). Its key is wrong or it was switched off ` +
        'on the dashboard. This does not fix itself: an administrator must rotate the secret ' +
        'or switch the device on.',
    );
    this.name = 'TerminalNotTrusted';
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
    });

    if (response.status === 401) {
      throw new TerminalNotTrusted(credentials.deviceId);
    }
    if (!response.ok) {
      throw new ApiRequestFailed(response.status, route);
    }
    if (response.status === 204) {
      return undefined as Answer;
    }
    return (await response.json()) as Answer;
  }
}
