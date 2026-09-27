import { type FormEvent, useState } from 'react';
import { type PairedDevice, pairDevice } from '@/lib/device';

/** The contract's device id and secret shapes, checked before anything is stored. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_MIN_LENGTH = 20;

interface PairingScreenProps {
  onPaired: (device: PairedDevice) => void;
}

/**
 * Setting a phone up as a kiosk, once, by an administrator.
 *
 * An ADMIN registers the kiosk on the dashboard's Devices page, which shows the
 * secret **once**, and types it in here. The kiosk never holds an administrator's
 * sign-in of its own — which is deliberate: a phone screwed to a wall at a gate
 * is the least private computer in the company, and an admin session on it would
 * be a way into everything. The device secret only opens the kiosk routes.
 *
 * The secret is turned into a key the browser will not hand back the moment it
 * is submitted, and is never written down anywhere (`lib/device.ts`).
 *
 * Design: docs/plan/13-biometrics-design.md section 2.
 */
export function PairingScreen({ onPaired }: PairingScreenProps) {
  const [deviceId, setDeviceId] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }
    const id = deviceId.trim();
    const key = secret.trim();
    if (!UUID.test(id)) {
      setProblem('That device ID does not look right. Copy it from the kiosk’s page.');
      return;
    }
    if (key.length < SECRET_MIN_LENGTH) {
      setProblem('That secret looks too short. Copy the whole thing.');
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      onPaired(await pairDevice(id, key, name.trim() === '' ? 'This kiosk' : name.trim()));
    } catch {
      // Private browsing and cleared site data both land here. Saying which is
      // guesswork, so say what to do instead.
      setProblem(
        'This phone would not store the key. Check that the browser is not in private mode, then try again.',
      );
      setSaving(false);
    }
  }

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>SAMTEC</strong>
        <span>Kiosk set-up</span>
      </div>

      <h1>Set this phone up</h1>
      <p className="muted" style={{ maxWidth: '30rem' }}>
        An administrator registers this kiosk on the dashboard, under Devices. The secret is shown
        once there — paste it here. Nobody signs in on this phone.
      </p>

      {/* noValidate: the screen's own messages are clearer than the browser's,
          and a guard may be watching over the administrator's shoulder. */}
      <form noValidate onSubmit={submit} className="buttons" style={{ maxWidth: '30rem' }}>
        <div className="field">
          <label htmlFor="pair-name">What to call this kiosk</label>
          <input
            id="pair-name"
            autoComplete="off"
            placeholder="Main Gate kiosk"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="pair-id">Device ID</label>
          <input
            id="pair-id"
            className="mono"
            autoComplete="off"
            spellCheck={false}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="pair-secret">Device secret</label>
          <input
            id="pair-secret"
            className="mono"
            // `password`, so it is not left readable on a screen on a wall.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>

        {problem !== null && (
          <p className="notice notice--bad" role="alert">
            {problem}
          </p>
        )}

        <button type="submit" className="button button--in" disabled={saving}>
          {saving ? 'Saving…' : 'Finish set-up'}
        </button>

        <p className="small muted">
          The secret is turned into a key this phone can use but cannot read back, and the secret
          itself is not kept. If this phone is ever lost, switch the device off on the dashboard —
          that is what stops it, not anything here.
        </p>
      </form>
    </div>
  );
}
