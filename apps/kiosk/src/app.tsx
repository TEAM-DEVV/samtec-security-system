import { useEffect, useMemo, useState } from 'react';
import { type AdminSession, hasExpired, signOut } from '@/lib/admin-session';
import { forgetDevice, loadDevice, type PairedDevice } from '@/lib/device';
import type { FaceEngine } from '@/lib/face';
import { HumanFaceEngine } from '@/lib/face-human';
import { MockFaceEngine } from '@/lib/face-mock';
import { HEARTBEAT_MILLISECONDS, startHeartbeat } from '@/lib/heartbeat';
import { AdminMenuScreen } from '@/screens/admin-menu-screen';
import { AdminSignInScreen } from '@/screens/admin-sign-in-screen';
import { ClockScreen } from '@/screens/clock-screen';
import { EnrollScreen, type Task } from '@/screens/enroll-screen';
import { KioskSettingsScreen } from '@/screens/kiosk-settings-screen';
import { PairingScreen } from '@/screens/pairing-screen';

/**
 * The kiosk app.
 *
 * Two states and no router: a phone is either set up or it is not. A router
 * would let somebody type their way to a screen, and every screen here except
 * the everyday one belongs to an administrator.
 *
 * The face engine is a parameter rather than something this component builds, so
 * a test can hand in a pretend camera and the real Human engine can drop in
 * later without this file changing (`lib/face.ts` explains why that seam exists).
 */
interface AppProps {
  /** A pretend camera, for tests and for development on a machine with none. */
  engine?: FaceEngine;
}

/**
 * The camera to use when nobody passed one in.
 *
 * A production build always gets the real Human engine (`lib/face-human.ts`),
 * with the models served from this app's own origin. Development keeps the
 * pretend camera so `pnpm dev:kiosk` runs on any machine with no camera at
 * all — set `VITE_FACE_ENGINE=human` to try the real one locally.
 *
 * **The pretend camera must never reach a real kiosk.** It accepts any frame,
 * so a deployed build running on it would do no face check at all: anybody
 * could clock in as the last person the server matched. That is why the
 * choice here reads the build mode, never a setting a deployment could get
 * wrong: there is no value that puts the pretend camera into a production
 * build.
 */
function defaultEngine(): FaceEngine {
  if (import.meta.env.PROD || import.meta.env.VITE_FACE_ENGINE === 'human') {
    return new HumanFaceEngine();
  }
  return new MockFaceEngine();
}

export function App({ engine }: AppProps = {}) {
  const [device, setDevice] = useState<PairedDevice | null>(null);
  /**
   * Which screen an administrator has opened, if any.
   *
   * `null` is the everyday kiosk. Nothing here is stored: a reload puts the
   * phone back to the clock-in screen with no session, which is the right
   * behaviour for a shared device on a wall. Signing in opens the admin menu,
   * never the enrol screen directly — every admin task, including leaving one,
   * passes back through it so none of them has to know how to sign out.
   */
  const [adminScreen, setAdminScreen] = useState<
    'signing-in' | 'menu' | 'enrolling' | 'settings' | null
  >(null);
  /** Which job the enrol screen should open on, set just before it is shown. */
  const [enrollTask, setEnrollTask] = useState<Task>('enroll');
  /**
   * Whether this device may save a fingerprint on its own sensor, as the
   * most recent heartbeat reported. Starts `false`, the safe side to be
   * wrong on for the moment before the first heartbeat answers: offering a
   * button that is actually off would be a dead end, where offering the
   * message first and finding fingerprints are on costs nothing.
   */
  const [passkeysEnabled, setPasskeysEnabled] = useState(false);
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [looking, setLooking] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  // One engine for the life of the app: starting a camera is slow, and a new
  // one per render would ask Android for permission again.
  const camera = useMemo(() => engine ?? defaultEngine(), [engine]);

  useEffect(() => {
    let stillMounted = true;
    loadDevice()
      .then((found) => {
        if (stillMounted) {
          setDevice(found);
          setLooking(false);
        }
      })
      .catch(() => {
        if (stillMounted) {
          // A browser that will not open IndexedDB cannot hold a key, so this
          // phone cannot be a kiosk at all. Say that rather than showing a
          // set-up form that will fail at the last step.
          setProblem(
            'This browser will not let the kiosk store its key. Private mode and blocked site data both do this.',
          );
          setLooking(false);
        }
      });
    return () => {
      stillMounted = false;
    };
  }, []);

  // Starts as soon as the phone is paired and runs for as long as the app is
  // open. Not tied to a screen: a kiosk sitting on "Ready" all night is exactly
  // when the server most needs the tick (see `lib/heartbeat.ts`).
  useEffect(() => {
    if (device === null) {
      return;
    }
    return startHeartbeat(device, HEARTBEAT_MILLISECONDS, (response) => {
      setPasskeysEnabled(response.passkeysEnabled);
    });
  }, [device]);

  // An administrator who walks away must not leave a session on a wall. The
  // server's token dies in fifteen minutes regardless; this makes the screen
  // agree with it rather than failing a request later and looking broken.
  useEffect(() => {
    if (admin === null) {
      return;
    }
    const timer = setInterval(() => {
      if (hasExpired(admin)) {
        setAdmin(null);
        setAdminScreen(null);
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [admin]);

  if (looking) {
    return (
      <div className="screen screen--centred">
        <div className="spinner" aria-hidden="true" />
        <p role="status">Starting…</p>
      </div>
    );
  }

  if (problem !== null) {
    return (
      <div className="screen screen--centred">
        <h1>This phone cannot be a kiosk</h1>
        <p className="notice notice--bad" role="alert">
          {problem}
        </p>
      </div>
    );
  }

  if (device === null) {
    return <PairingScreen onPaired={setDevice} />;
  }

  /** Signs the administrator out and returns to the everyday clock-in screen. */
  function backToClockIn() {
    // Signed out on the way back, not left to time out: the next person to
    // touch this phone is a guard clocking in.
    if (admin !== null) {
      void signOut(admin);
    }
    setAdmin(null);
    setAdminScreen(null);
  }

  if (adminScreen === 'signing-in') {
    return (
      <AdminSignInScreen
        onSignedIn={(session) => {
          setAdmin(session);
          setAdminScreen('menu');
        }}
        onCancel={() => setAdminScreen(null)}
      />
    );
  }

  if (adminScreen === 'menu' && admin !== null) {
    return (
      <AdminMenuScreen
        admin={admin}
        passkeysEnabled={passkeysEnabled}
        onEnroll={() => {
          setEnrollTask('enroll');
          setAdminScreen('enrolling');
        }}
        onFingerprint={() => {
          setEnrollTask('finger');
          setAdminScreen('enrolling');
        }}
        onSettings={() => setAdminScreen('settings')}
        onBackToClockIn={backToClockIn}
      />
    );
  }

  if (adminScreen === 'settings' && admin !== null) {
    return (
      <KioskSettingsScreen onBack={() => setAdminScreen('menu')} onDeviceChanged={setDevice} />
    );
  }

  if (adminScreen === 'enrolling' && admin !== null) {
    return (
      <EnrollScreen
        device={device}
        admin={admin}
        engine={camera}
        initialTask={enrollTask}
        // Leaving a task returns to the menu, not straight out: enrolling
        // somebody and then saving a fingerprint should not need signing in
        // twice. "Back to clock-in" on the menu is the only way out.
        onDone={() => setAdminScreen('menu')}
      />
    );
  }

  return (
    <ClockScreen
      device={device}
      engine={camera}
      onAdmin={() => setAdminScreen('signing-in')}
      onSetUpAgain={() => {
        // Offered only when the server has refused this phone's key (a 401).
        // A well-formed but wrong secret pairs happily and then fails every
        // request, and without this the phone has no way back at all. If
        // another device is still stored here, forgetting this one falls
        // back to it rather than forcing the set-up form unnecessarily.
        void forgetDevice().then(setDevice);
      }}
    />
  );
}
