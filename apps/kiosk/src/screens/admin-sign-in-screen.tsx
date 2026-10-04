import { type FormEvent, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { type AdminSession, signIn, verifyCode } from '@/lib/admin-session';
import { KioskRequestFailed } from '@/lib/api';

/** The contract's `TwoFactorCode`: six digits. */
const CODE_LENGTH = 6;

interface AdminSignInScreenProps {
  onSignedIn: (session: AdminSession) => void;
  onCancel: () => void;
}

/**
 * An administrator signing in at the kiosk, to enrol somebody.
 *
 * Only an ADMIN can sign in here at all — the server refuses every other role,
 * whatever the password — and the session it gets is deliberately poor: no
 * refresh token, fifteen minutes, and it works on the kiosk screens and nowhere
 * else. So a password typed on a phone on a wall buys an attacker a quarter of an
 * hour of enrollment screens, and not the dashboard.
 *
 * Two-factor **set-up** is refused here rather than offered. It means showing a
 * QR code and a secret key on a screen bolted to a wall in a public place; that
 * belongs on the dashboard.
 *
 * Design: docs/plan/13-biometrics-design.md section 2.
 */
export function AdminSignInScreen({ onSignedIn, onCancel }: AdminSignInScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      if ('session' in result) {
        onSignedIn(result.session);
        return;
      }
      setChallengeToken(result.codeNeeded.challengeToken);
      // The password is finished with. Keeping it in state on a kiosk screen
      // serves no purpose and is one more thing that could be read.
      setPassword('');
    } catch (error) {
      setProblem(error instanceof KioskRequestFailed ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || challengeToken === null) {
      return;
    }
    if (code.trim().length !== CODE_LENGTH) {
      setProblem(`The code is ${CODE_LENGTH} digits.`);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      onSignedIn(await verifyCode(challengeToken, code.trim()));
    } catch (error) {
      setProblem(error instanceof KioskRequestFailed ? error.message : 'Please try again.');
      setCode('');
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
        <span>Administrator</span>
      </div>

      <h1>{challengeToken === null ? 'Sign in' : 'Your code'}</h1>
      <p className="muted" style={{ maxWidth: '30rem' }}>
        {challengeToken === null
          ? 'Only an administrator can sign in here, for the admin menu: enrolling a worker, saving a fingerprint and kiosk settings. The session ends by itself after fifteen minutes.'
          : 'Open your authenticator app and type the six digits it shows.'}
      </p>

      {/* noValidate: the screen's own messages are clearer, and somebody may be
          watching over the administrator's shoulder. */}
      {challengeToken === null ? (
        <form
          noValidate
          onSubmit={submitPassword}
          className="buttons"
          style={{ maxWidth: '30rem' }}
        >
          <div className="field">
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}

          <button type="submit" className="button button--in" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Back
          </button>
        </form>
      ) : (
        <form noValidate onSubmit={submitCode} className="buttons" style={{ maxWidth: '30rem' }}>
          <div className="field">
            <label htmlFor="admin-code">Six-digit code</label>
            <input
              id="admin-code"
              className="mono"
              // `numeric` brings up a number pad on a phone, and `one-time-code`
              // lets the phone offer the code it has just seen.
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </div>

          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}

          <button type="submit" className="button button--in" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Back
          </button>
        </form>
      )}
    </div>
  );
}
