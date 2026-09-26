import { useEffect, useMemo, useState } from 'react';
import { loadDevice, type PairedDevice } from '@/lib/device';
import type { FaceEngine } from '@/lib/face';
import { MockFaceEngine } from '@/lib/face-mock';
import { ClockScreen } from '@/screens/clock-screen';
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

export function App({ engine }: AppProps = {}) {
  const [device, setDevice] = useState<PairedDevice | null>(null);
  const [looking, setLooking] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  // One engine for the life of the app: starting a camera is slow, and a new
  // one per render would ask Android for permission again.
  const camera = useMemo(() => engine ?? new MockFaceEngine(), [engine]);

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

  return <ClockScreen device={device} engine={camera} />;
}
