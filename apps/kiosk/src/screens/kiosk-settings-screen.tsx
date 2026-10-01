import { useCallback, useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import {
  forgetDevice,
  listDevices,
  type PairedDevice,
  type StoredDeviceSummary,
  switchDevice,
} from '@/lib/device';
import { PairingScreen } from '@/screens/pairing-screen';

interface KioskSettingsScreenProps {
  onBack: () => void;
  /**
   * The device this phone acts as changed: one was added, switched to, or
   * forgotten. `null` means none is left, and the app falls back to the
   * set-up form on its own — this screen does not need to know that happened.
   */
  onDeviceChanged: (device: PairedDevice | null) => void;
}

/**
 * Kiosk settings, behind the admin sign-in: adding a device this phone can
 * stand in for, switching which one it is acting as, and forgetting one.
 *
 * A phone screwed to a wall is normally one kiosk for its whole life. This
 * screen is for the phones that are not that — testing needs more devices
 * than there are phones, so a handful of phones switch between the devices
 * registered for them. Every change here goes through `lib/device.ts`, the
 * one place allowed to touch the stored keys; this screen only ever shows
 * what that file reports, and never reads a key back out of it.
 *
 * Design: issue #99 task 2.
 */
export function KioskSettingsScreen({ onBack, onDeviceChanged }: KioskSettingsScreenProps) {
  const [devices, setDevices] = useState<StoredDeviceSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listDevices()
      .then(setDevices)
      .catch(() => setProblem('Could not read the devices stored on this phone.'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (adding) {
    return (
      <PairingScreen
        onPaired={(device) => {
          onDeviceChanged(device);
          setAdding(false);
          refresh();
        }}
      />
    );
  }

  async function handleSwitch(deviceId: string) {
    setBusy(true);
    setProblem(null);
    try {
      const switched = await switchDevice(deviceId);
      if (switched === null) {
        // A forget on another screen, or another tab, won the race.
        setProblem('That device is no longer stored on this phone.');
        refresh();
        return;
      }
      onDeviceChanged(switched);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleForget() {
    setBusy(true);
    setProblem(null);
    try {
      const fallback = await forgetDevice();
      onDeviceChanged(fallback);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>
          <BrandMark />
          SAMTEC
        </strong>
        <span>Kiosk settings</span>
      </div>

      <h1>Kiosk settings</h1>

      <div className="buttons">
        <button type="button" className="button" onClick={() => setAdding(true)}>
          Add a device
        </button>
      </div>

      <div className="buttons" style={{ textAlign: 'left' }}>
        <p className="small muted" style={{ margin: 0 }}>
          Devices stored on this phone
        </p>
        {devices === null && <p className="muted">Reading the stored devices…</p>}
        {devices !== null && devices.length === 0 && (
          <p className="muted">No device is stored on this phone.</p>
        )}
        {devices?.map((device) =>
          device.active ? (
            <div
              key={device.deviceId}
              className="notice notice--good"
              style={{ textAlign: 'left' }}
            >
              <strong>{device.name}</strong> · Active now
              <br />
              <span className="small mono">{device.deviceId}</span>
              <br />
              <span className="small">Added {dateAdded(device.pairedAt)}</span>
            </div>
          ) : (
            <button
              key={device.deviceId}
              type="button"
              className="button"
              style={{ textAlign: 'left' }}
              disabled={busy}
              onClick={() => void handleSwitch(device.deviceId)}
            >
              Switch to {device.name}
              <br />
              <span className="small mono">{device.deviceId}</span>
              <br />
              <span className="small">Added {dateAdded(device.pairedAt)}</span>
            </button>
          ),
        )}
      </div>

      {problem !== null && (
        <p className="notice notice--bad" role="alert">
          {problem}
        </p>
      )}

      <div className="buttons">
        <button
          type="button"
          className="button button--danger"
          disabled={busy || devices === null}
          onClick={() => void handleForget()}
        >
          Forget this device
        </button>
        <button type="button" className="button button--quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

/**
 * A plain calendar date, in UTC rather than the phone's own zone — Ghana
 * keeps UTC+0 all year, and a phone set to the wrong zone must not show a
 * different date than the dashboard does for the same device (`clock-screen.tsx`
 * formats the clock-in time the same way, for the same reason).
 */
function dateAdded(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return at.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
