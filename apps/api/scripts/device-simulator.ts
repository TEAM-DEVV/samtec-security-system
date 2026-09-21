import { createHash } from 'node:crypto';
import type { HeartbeatResponse, IngestPunch, IngestPunchesResponse } from '@samtec/contracts';
import { type SignedRoute, signRequest } from '../src/modules/attendance/device-signature.js';

/**
 * A pretend clock-in terminal, for demos and tests. To the API it looks
 * exactly like a real one (or the Phase 3 gateway): it signs every request
 * with its device secret and sends batches to `POST /ingest/punches`. It
 * never touches the database.
 */

export interface SimulatedDevice {
  /** For example `http://localhost:3000/api/v1`. */
  apiUrl: string;
  id: string;
  secret: string;
  /** How many seconds the terminal's clock runs fast (negative: slow). */
  clockDriftSeconds?: number;
}

export interface SimulatedGuard {
  /** The number enrolled on the terminal: the digits of the staff number. */
  deviceUserRef: string;
  /** Shift start and end in minutes from midnight, Ghana time (= UTC). */
  startMinutes: number;
  endMinutes: number;
}

/** A punch exactly as the contract describes it (`IngestPunch`). */
export type SimulatedPunch = IngestPunch;

/** The totals of `IngestPunchesResponse`, added up over every batch. */
export type SendSummary = Pick<IngestPunchesResponse, 'accepted' | 'duplicates' | 'conflicts'>;

/** The usual shifts, for `--shift`. */
export const SHIFTS = {
  day: { startMinutes: 6 * 60, endMinutes: 18 * 60 },
  night: { startMinutes: 18 * 60, endMinutes: 6 * 60 },
  'night-watch': { startMinutes: 22 * 60, endMinutes: 6 * 60 },
} as const;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BATCH_SIZE = 100;

/** A repeatable "random" number from 0 to 1 for a key, so every run plays the same story. */
function chance(key: string): number {
  return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 2 ** 32;
}

/**
 * The punches these guards would have made over the last `days` days
 * (today included): their
 * shift pattern with a few minutes' jitter, about one rest day in seven, and
 * the everyday mistakes the exception queue exists for (a forgotten clock-out
 * or clock-in, a repeat tap, the wrong key, a PIN instead of a finger). Event
 * IDs are fixed per guard, day and act, so sending them twice changes nothing.
 * Times are what the terminal's own clock said, so a fast clock's punches
 * can be up to its drift later than the real time.
 */
export function planPunches(input: {
  guards: SimulatedGuard[];
  days: number;
  now: Date;
  clockDriftSeconds?: number;
}): SimulatedPunch[] {
  const drift = (input.clockDriftSeconds ?? 0) * 1000;
  const today = new Date(input.now);
  today.setUTCHours(0, 0, 0, 0);
  const punches: SimulatedPunch[] = [];

  for (const guard of input.guards) {
    const shiftMinutes = (guard.endMinutes - guard.startMinutes + 1440) % 1440 || 1440;
    for (let daysAgo = input.days - 1; daysAgo >= 0; daysAgo -= 1) {
      const midnight = today.getTime() - daysAgo * DAY_MS;
      const date = new Date(midnight).toISOString().slice(0, 10);
      const key = `${guard.deviceUserRef}:${date}`;
      if (chance(`${key}:rest`) < 1 / 7) {
        continue;
      }
      const jitterIn = Math.floor(chance(`${key}:in`) * 14) - 8; // 8 early to 5 late
      const jitterOut = Math.floor(chance(`${key}:out`) * 20) - 5; // 5 early to 14 late
      const inAt = midnight + (guard.startMinutes + jitterIn) * MINUTE_MS;
      const outAt = midnight + (guard.startMinutes + shiftMinutes + jitterOut) * MINUTE_MS;
      if (inAt > input.now.getTime()) {
        continue;
      }

      const mistake = chance(`${key}:mistake`);
      const punch = (
        act: string,
        at: number,
        direction: SimulatedPunch['direction'],
        method: SimulatedPunch['method'] = 'FINGERPRINT',
      ) =>
        punches.push({
          deviceEventId: `${guard.deviceUserRef}-${date}-${act}`,
          deviceUserRef: guard.deviceUserRef,
          // What the terminal's own clock said.
          deviceTime: new Date(at + drift).toISOString(),
          direction,
          method,
        });

      if (mistake >= 0.015 && mistake < 0.025) {
        // Forgot to clock in: only the OUT below.
      } else {
        punch('in', inAt, 'IN', mistake >= 0.09 && mistake < 0.1 ? 'PIN_FALLBACK' : 'FINGERPRINT');
      }
      if (mistake >= 0.025 && mistake < 0.07 && inAt + 40_000 <= input.now.getTime()) {
        punch('in-again', inAt + 40_000, 'IN'); // A nervous second tap.
      }
      const forgotOut = mistake < 0.015;
      if (!forgotOut && outAt <= input.now.getTime()) {
        punch('out', outAt, mistake >= 0.07 && mistake < 0.09 ? 'UNKNOWN' : 'OUT');
      }
    }
  }
  return punches.sort((a, b) => a.deviceTime.localeCompare(b.deviceTime));
}

/**
 * Sends punches in batches of up to 100, oldest first, as a terminal that
 * was offline does when it reconnects. A busy (503) or rate-limited (429)
 * answer is retried after `Retry-After`, as a real device should.
 */
export async function sendPunches(
  device: SimulatedDevice,
  punches: SimulatedPunch[],
  options: { resendLastBatch?: boolean } = {},
): Promise<SendSummary> {
  const total: SendSummary = { accepted: 0, duplicates: 0, conflicts: 0 };
  const batches: SimulatedPunch[][] = [];
  for (let start = 0; start < punches.length; start += BATCH_SIZE) {
    batches.push(punches.slice(start, start + BATCH_SIZE));
  }
  const lastBatch = batches.at(-1);
  if (options.resendLastBatch && lastBatch) {
    batches.push(lastBatch);
  }
  for (const batch of batches) {
    const answer = await postSigned<IngestPunchesResponse>(device, 'ingest/punches', {
      deviceClockAt: deviceClock(device),
      punches: batch,
    });
    total.accepted += answer.accepted;
    total.duplicates += answer.duplicates;
    total.conflicts += answer.conflicts;
  }
  return total;
}

/** A heartbeat: the API measures the clock drift and looks for forgotten clock-outs. */
export async function sendHeartbeat(device: SimulatedDevice): Promise<void> {
  await postSigned<HeartbeatResponse>(device, 'ingest/heartbeat', {
    deviceClockAt: deviceClock(device),
  });
}

function deviceClock(device: SimulatedDevice): string {
  return new Date(Date.now() + (device.clockDriftSeconds ?? 0) * 1000).toISOString();
}

/**
 * One signed request. The signature's timestamp comes from this computer's
 * correct clock (like the Phase 3 gateway's), never from the terminal's, so a
 * terminal with a fast clock can still connect and its drift gets measured.
 */
async function postSigned<Answer>(
  device: SimulatedDevice,
  route: SignedRoute,
  body: unknown,
): Promise<Answer> {
  const text = JSON.stringify(body);
  for (let attempt = 1; ; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${device.apiUrl}/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Samtec-Device': device.id,
        'X-Samtec-Timestamp': timestamp,
        'X-Samtec-Signature': signRequest(device.secret, timestamp, route, text),
      },
      body: text,
    });
    if ((response.status === 503 || response.status === 429) && attempt < 5) {
      const waitSeconds = Number(response.headers.get('retry-after') ?? '5');
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`${route} answered ${response.status}: ${await response.text()}`);
    }
    // A successful answer has the contract's shape; anything else stopped the demo above.
    return (await response.json()) as Answer;
  }
}
