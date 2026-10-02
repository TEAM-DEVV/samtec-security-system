import type { HeartbeatResponse } from '@samtec/contracts';
import { callSigned } from '@/lib/api';
import type { PairedDevice } from '@/lib/device';

/**
 * The minute tick every kiosk owes the server.
 *
 * This looks like a nicety and is not. The API has **no scheduled job** for
 * either of the two things that ride on it
 * (`apps/api/src/modules/attendance/ingest.service.ts`):
 *
 * - `repairOverdueClockIns` — the only way a forgotten clock-out is ever
 *   noticed when nothing else happens at that site.
 * - the biometric retention sweep — the only thing that deletes a face template
 *   when its time is up, which is a promise made to every worker who consented.
 *
 * So a kiosk that does not tick is a kiosk where nobody's shift gets repaired
 * and nobody's biometrics are ever deleted. Design:
 * docs/plan/13-biometrics-design.md section 3, and decision: the design chose a
 * heartbeat over a cron entry precisely so there is no extra secret to manage.
 *
 * `deviceClockAt` is sent so the server can see this phone's clock drifting
 * before a guard's punch lands at the wrong minute.
 */

/** The design's interval. One minute, so the daily sweep happens in practice. */
export const HEARTBEAT_MILLISECONDS = 60_000;

/**
 * While an administrator is signed in on the kiosk: often enough that a
 * setting just changed on the dashboard (fingerprints on or off) shows here
 * within seconds.
 */
export const ADMIN_HEARTBEAT_MILLISECONDS = 15_000;

/**
 * Starts the tick. Returns the function that stops it.
 *
 * Failures are swallowed on purpose: a gate loses signal, and the next tick
 * tries again a minute later. There is nothing useful to show a guard about a
 * heartbeat, and an error on this screen would frighten somebody who is only
 * trying to start their shift.
 *
 * `onUpdate` sees the server's answer on every tick that succeeds — today
 * that is only `passkeysEnabled`, so the kiosk knows whether to offer saving
 * a fingerprint without asking the server again on its own.
 */
export function startHeartbeat(
  device: PairedDevice,
  everyMilliseconds: number = HEARTBEAT_MILLISECONDS,
  onUpdate?: (response: HeartbeatResponse) => void,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      const response = await callSigned<HeartbeatResponse>(device, 'ingest/heartbeat', {
        deviceClockAt: new Date().toISOString(),
      });
      // A reply that arrives after this heartbeat was stopped belongs to a
      // device the kiosk has switched away from: it must not overwrite the
      // new device's settings.
      if (!stopped) {
        onUpdate?.(response);
      }
    } catch {
      // Deliberately silent. See above.
    }
  };

  // One straight away, so a kiosk that has just been switched on is counted as
  // seen without waiting a minute for it.
  void tick();
  const timer = setInterval(() => void tick(), everyMilliseconds);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
