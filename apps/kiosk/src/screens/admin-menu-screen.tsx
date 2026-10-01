import { BrandMark } from '@/components/brand-mark';
import type { AdminSession } from '@/lib/admin-session';

interface AdminMenuScreenProps {
  admin: AdminSession;
  /** Opens the enrol screen on the face task. */
  onEnroll: () => void;
  /** Opens the enrol screen with the fingerprint task preselected. */
  onFingerprint: () => void;
  onSettings: () => void;
  /** Signs the administrator out and returns to the everyday clock-in screen. */
  onBackToClockIn: () => void;
}

/**
 * What an administrator sees right after signing in.
 *
 * Signing in used to drop an administrator straight into enrolling, with no
 * way to reach anything else without starting over. This is the one screen
 * that fixes that: every admin task is a named item here, and "Back to
 * clock-in" is the only way this screen ends the session — leaving a task
 * (the enrol screen's own "Done") comes back here instead, so doing two
 * things does not mean signing in twice.
 *
 * Nothing here is itself a sensitive action — the sign-in a moment ago is the
 * real gate — so this screen is just a signpost. The fifteen-minute session
 * keeps ticking underneath it exactly as it does on every other admin screen.
 *
 * Design: issue #99 task 1.
 */
export function AdminMenuScreen({
  admin,
  onEnroll,
  onFingerprint,
  onSettings,
  onBackToClockIn,
}: AdminMenuScreenProps) {
  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>
          <BrandMark />
          SAMTEC
        </strong>
        <span>Admin menu · {admin.fullName}</span>
      </div>

      <h1>Admin menu</h1>
      <p className="muted" style={{ maxWidth: '30rem' }}>
        Choose what you came to do. This ends by itself after fifteen minutes.
      </p>

      <div className="buttons">
        <button type="button" className="button" onClick={onEnroll}>
          Enroll a worker’s face
        </button>
        <button type="button" className="button" onClick={onFingerprint}>
          Save a fingerprint
        </button>
        <button type="button" className="button" onClick={onSettings}>
          Kiosk settings
        </button>
        <button type="button" className="button button--quiet" onClick={onBackToClockIn}>
          Back to clock-in
        </button>
      </div>
    </div>
  );
}
