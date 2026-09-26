import type {
  FaceSample,
  KioskDirection,
  KioskIdentifyResponse,
  KioskPunchResponse,
} from '@samtec/contracts';
import { useEffect, useRef, useState } from 'react';
import { callSigned, KioskRequestFailed } from '@/lib/api';
import type { PairedDevice } from '@/lib/device';
import {
  CHALLENGE_SECONDS,
  type FaceEngine,
  type HeadTurn,
  headTurnInstruction,
  randomHeadTurn,
  readingIsUsable,
} from '@/lib/face';

/** How long the name stays on screen before the punch is recorded. */
const SHOW_THE_NAME_MILLISECONDS = 2000;
/** How often the pretend or real camera is read while a challenge runs. */
const READ_EVERY_MILLISECONDS = 200;
/** After this many failures in a row, the fallbacks are offered. */
const FAILURES_BEFORE_FALLBACK = 3;

/** Where the screen is in the one flow it has. */
type Stage =
  | { name: 'resting' }
  | { name: 'challenging'; direction: KioskDirection; turn: HeadTurn; turned: boolean }
  | { name: 'asking'; direction: KioskDirection }
  | { name: 'greeting'; attemptId: string; displayName: string; direction: KioskDirection }
  | { name: 'recording' }
  | { name: 'done'; punch: KioskPunchResponse }
  | { name: 'refused'; message: string; offerFallback: boolean };

interface ClockScreenProps {
  device: PairedDevice;
  engine: FaceEngine;
  /** Overridable so a test does not wait two real seconds to see the name. */
  showTheNameFor?: number;
  /**
   * How long the head turn may take. Overridable so a test of the refusal does
   * not sit through the real twenty seconds.
   */
  challengeSeconds?: number;
}

/**
 * The everyday screen: a guard walks up, looks at the phone, and their shift
 * starts.
 *
 * Nobody signs in here. The guard at the gate has no account — the device's own
 * signature is the whole authority, which is why a kiosk can never post a raw
 * punch (the server makes the punch from the face match, so a stolen kiosk key
 * cannot invent attendance).
 *
 * **Nothing on this screen ever shows a score, and never says who a face looked
 * like.** Anyone at all can stand in front of a kiosk, so every message has to
 * be safe to show a stranger: a name they have just proved, or "try again".
 *
 * Design: docs/plan/13-biometrics-design.md sections 3 and 7.
 */
export function ClockScreen({
  device,
  engine,
  showTheNameFor = SHOW_THE_NAME_MILLISECONDS,
  challengeSeconds = CHALLENGE_SECONDS,
}: ClockScreenProps) {
  const [stage, setStage] = useState<Stage>({ name: 'resting' });
  const [failures, setFailures] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  // Read inside timers and awaited work, which may outlive the stage that
  // started them, so it cannot be state.
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
      engine.stop();
    };
  }, [engine]);

  /** Starts a clock-in or clock-out: the head turn first, then the server. */
  async function begin(direction: KioskDirection) {
    cancelled.current = false;
    const turn = randomHeadTurn();
    setStage({ name: 'challenging', direction, turn, turned: false });
    try {
      if (video.current !== null) {
        await engine.start(video.current);
      }
    } catch {
      setStage({
        name: 'refused',
        message: 'The camera would not start. Tell your supervisor.',
        offerFallback: false,
      });
      return;
    }
    await runChallenge(direction, turn);
  }

  /**
   * Waits for the head to turn the way it was asked, then takes one centred
   * sample.
   *
   * This is what a printed photograph cannot do, and it is the kiosk's own job:
   * the server checks the numbers again but it cannot see the camera, so if this
   * is weak the whole thing is weak.
   */
  async function runChallenge(direction: KioskDirection, turn: HeadTurn) {
    const deadline = Date.now() + challengeSeconds * 1000;
    let turned = false;

    while (Date.now() < deadline) {
      if (cancelled.current) {
        return;
      }
      const reading = await engine.read();
      if (!turned && reading.turnedTo === turn) {
        turned = true;
        setStage({ name: 'challenging', direction, turn, turned: true });
      } else if (turned && reading.turnedTo === null && readingIsUsable(reading)) {
        // Turned, then came back to centre, and this frame is good enough.
        await identify(direction, reading.sample);
        return;
      }
      await wait(READ_EVERY_MILLISECONDS);
    }

    engine.stop();
    countFailure('That did not work. Stand square to the screen and try again.');
  }

  async function identify(direction: KioskDirection, sample: FaceSample) {
    setStage({ name: 'asking', direction });
    try {
      const answer = await callSigned<KioskIdentifyResponse>(device, 'kiosk/identify', {
        purpose: 'CLOCK',
        direction,
        sample,
      });
      engine.stop();
      if (cancelled.current) {
        return;
      }
      if (answer.outcome !== 'MATCHED' || answer.worker === null) {
        // AMBIGUOUS, NOT_RECOGNISED and LOW_LIVENESS all say the same thing to
        // the person standing there. Telling them apart would tell a stranger
        // something about the faces we hold.
        countFailure('Not recognised. Please try again.');
        return;
      }
      setStage({
        name: 'greeting',
        attemptId: answer.attemptId,
        displayName: answer.worker.displayName,
        direction,
      });
    } catch (error) {
      engine.stop();
      setStage({
        name: 'refused',
        message: error instanceof KioskRequestFailed ? error.message : 'Please try again.',
        offerFallback: false,
      });
    }
  }

  /** The guard said nothing, so the punch goes in. */
  async function confirm(attemptId: string) {
    setStage({ name: 'recording' });
    try {
      const punch = await callSigned<KioskPunchResponse>(device, 'kiosk/confirm', { attemptId });
      setFailures(0);
      setStage({ name: 'done', punch });
    } catch (error) {
      setStage({
        name: 'refused',
        message: error instanceof KioskRequestFailed ? error.message : 'Please try again.',
        offerFallback: false,
      });
    }
  }

  /** The guard pressed "Not me": the match is cancelled and counts as a failure. */
  async function notMe(attemptId: string) {
    try {
      await callSigned<void>(device, 'kiosk/not-me', { attemptId });
    } catch {
      // Recording the "not me" is useful but not essential; the guard still
      // needs to get on with their shift either way.
    }
    countFailure('Sorry about that. Please try again.');
  }

  function countFailure(message: string) {
    const nowFailed = failures + 1;
    setFailures(nowFailed);
    setStage({
      name: 'refused',
      message,
      offerFallback: nowFailed >= FAILURES_BEFORE_FALLBACK,
    });
  }

  function rest() {
    cancelled.current = true;
    engine.stop();
    setStage({ name: 'resting' });
  }

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>SAMTEC</strong>
        <span>{device.name}</span>
      </div>

      {/* The camera element stays mounted through every stage. Remounting it
          makes Android drop and re-request the camera, which takes seconds and
          sometimes asks permission again. */}
      <div className="camera" hidden={stage.name === 'resting' || stage.name === 'done'}>
        <video ref={video} playsInline muted autoPlay />
        {stage.name === 'challenging' && (
          <p className="camera__instruction">
            {stage.turned ? 'Now look straight ahead' : headTurnInstruction(stage.turn)}
          </p>
        )}
      </div>

      <Body
        stage={stage}
        showTheNameFor={showTheNameFor}
        onBegin={begin}
        onConfirm={confirm}
        onNotMe={notMe}
        onRest={rest}
      />
    </div>
  );
}

interface BodyProps {
  stage: Stage;
  showTheNameFor: number;
  onBegin: (direction: KioskDirection) => void;
  onConfirm: (attemptId: string) => void;
  onNotMe: (attemptId: string) => void;
  onRest: () => void;
}

function Body({ stage, showTheNameFor, onBegin, onConfirm, onNotMe, onRest }: BodyProps) {
  // The name is shown for two seconds with a way out, then the punch goes in.
  // The wait is the whole point of "Not me": without it nobody could object.
  useEffect(() => {
    if (stage.name !== 'greeting') {
      return;
    }
    const timer = setTimeout(() => onConfirm(stage.attemptId), showTheNameFor);
    return () => clearTimeout(timer);
  }, [stage, showTheNameFor, onConfirm]);

  switch (stage.name) {
    case 'resting':
      return (
        <>
          <h1>Ready</h1>
          <div className="buttons">
            <button type="button" className="button button--in" onClick={() => onBegin('IN')}>
              Start shift
            </button>
            <button type="button" className="button button--out" onClick={() => onBegin('OUT')}>
              End shift
            </button>
          </div>
        </>
      );

    case 'challenging':
      return (
        <p className="notice notice--wait" role="status">
          {stage.turned
            ? 'Good. Look straight ahead and hold still.'
            : 'Follow the instruction on the camera.'}
        </p>
      );

    case 'asking':
      return (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Checking…</p>
        </>
      );

    case 'greeting':
      return (
        <>
          <p className="greeting" role="status">
            Hello, {stage.displayName}
          </p>
          <p className="muted">
            {stage.direction === 'IN' ? 'Starting your shift' : 'Ending your shift'}
          </p>
          <div className="buttons">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => onNotMe(stage.attemptId)}
            >
              Not me
            </button>
          </div>
        </>
      );

    case 'recording':
      return (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Recording…</p>
        </>
      );

    case 'done':
      return (
        <>
          <h1>{stage.punch.direction === 'IN' ? 'Shift started' : 'Shift ended'}</h1>
          <p className="notice notice--good" role="status">
            Recorded for {stage.punch.worker.displayName}.{' '}
            {stage.punch.status === 'DUPLICATE'
              ? 'This was already recorded, so nothing was added twice.'
              : 'Have a good shift.'}
          </p>
          <div className="buttons">
            <button type="button" className="button" onClick={onRest}>
              Done
            </button>
          </div>
        </>
      );

    case 'refused':
      return (
        <>
          <p className="notice notice--bad" role="alert">
            {stage.message}
          </p>
          {stage.offerFallback && (
            <p className="notice notice--wait">
              Still not working? Use your staff number, or ask your supervisor to help you clock in.
            </p>
          )}
          <div className="buttons">
            <button type="button" className="button" onClick={onRest}>
              Start again
            </button>
          </div>
        </>
      );
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
