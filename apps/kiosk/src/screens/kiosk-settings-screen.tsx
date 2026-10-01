import { BrandMark } from '@/components/brand-mark';

interface KioskSettingsScreenProps {
  onBack: () => void;
}

/**
 * Kiosk settings, behind the admin sign-in.
 *
 * A placeholder for now: issue #99 task 2 fills this in with adding a device
 * and switching between the devices registered on this phone. It is already
 * its own screen, reached from the admin menu, so task 2 only has to fill in
 * the middle of it — nothing about how it is opened changes.
 */
export function KioskSettingsScreen({ onBack }: KioskSettingsScreenProps) {
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
      <p className="muted" style={{ maxWidth: '30rem' }}>
        Adding a device and switching between devices is coming soon.
      </p>

      <div className="buttons">
        <button type="button" className="button button--quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
