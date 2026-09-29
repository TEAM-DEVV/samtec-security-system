import type {
  FaceSample,
  KioskDirection,
  KioskIdentifyResponse,
  KioskPunchResponse,
} from '@samtec/contracts';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { FaceGuide, type GuideState } from '@/components/face-guide';
import { OutcomeMark } from '@/components/outcome-mark';
import { callSigned, KioskRequestFailed } from '@/lib/api';
import type { PairedDevice } from '@/lib/device';
import {
  CHALLENGE_SECONDS,
  type FaceEngine,
  type HeadTurn,
  headTurnInstruction,
  randomHeadTurn,
  readingIsLive,
  readingIsUsable,
} from '@/lib/face';
import {
  FingerprintRefused,
  getAssertion,
  type RequestOptionsJson,
  requestOptionsFrom,
} from '@/lib/passkeys';
import { FallbackScreen } from '@/screens/fallback-screen';

/** How long the name stays on screen before the punch is recorded. */
const SHOW_THE_NAME_MILLISECONDS = 2000;
/**
 * How long an answer stays on screen before the kiosk clears itself.
 *
 * A kiosk is a screen on a wall. Left alone it showed the last guard's name and
 * whether they had started or ended a shift until somebody pressed a button,
 * which tells everybody walking past who is on duty.
 */
const CLEAR_THE_SCREEN_AFTER_MILLISECONDS = 8000;
/**
 * How long a "touch the sensor" ask, with its name, may sit before the screen
 * clears itself. The sheet lives about a minute; a name on an idle wall
 * screen is the leak the constant above exists to prevent.
 */
const CLEAR_A_WAITING_NAME_MILLISECONDS = 60_000;
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
  | {
      /**
       * Matched, and this worker has a fingerprint key on this kiosk, so the
       * server will refuse a confirmation without it. The finger press is the
       * confirmation, so there is no two-second timer here — and "Not me"
       * stays on screen, because a fingerprint proves a saved finger, never a
       * named person.
       */
      name: 'fingerprinting';
      attemptId: string;
      displayName: string;
      direction: KioskDirection;
    }
  | { name: 'cancelling' }
  | { name: 'recording' }
  | { name: 'done'; punch: KioskPunchResponse }
  | {
      name: 'refused';
      message: string;
      offerFallback: boolean;
      direction?: KioskDirection;
      offerSetUpAgain?: boolean;
    }
  | { name: 'fallback'; direction: KioskDirection };

interface ClockScreenProps {
  device: PairedDevice;
  engine: FaceEngine;
  /** Forgets this kiosk, so an administrator can set the phone up again. */
  onSetUpAgain?: () => void;
  /** Opens the administrator's sign-in, for enrolling somebody. */
  onAdmin?: () => void;
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
  onSetUpAgain,
  onAdmin,
  showTheNameFor = SHOW_THE_NAME_MILLISECONDS,
  challengeSeconds = CHALLENGE_SECONDS,
}: ClockScreenProps) {
  const [stage, setStage] = useState<Stage>({ name: 'resting' });
  const [failures, setFailures] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  /**
   * Which attempt is the living one. Every flow captures the value at its
   * start and compares after every await: pressing "Not me", Cancel or
   * starting again bumps it, so a continuation from an earlier flow — a
   * finger sheet that finally resolved, a challenge loop mid-sleep — finds
   * itself stale and stops, instead of confirming a disowned attempt or
   * painting over a newer screen. A single "cancelled" boolean could not say
   * *which* flow was cancelled, and re-arming it for the new flow quietly
   * revived the old one.
   */
  const run = useRef(0);

  useEffect(() => {
    run.current += 1;
    return () => {
      run.current += 1;
      engine.stop();
    };
  }, [engine]);

  /** Starts a clock-in or clock-out: the head turn first, then the server. */
  async function begin(direction: KioskDirection) {
    const mine = ++run.current;
    const turn = randomHeadTurn();
    setStage({ name: 'challenging', direction, turn, turned: false });
    try {
      if (video.current !== null) {
        await engine.start(video.current);
      }
      // A real engine works the direction out from the frame and can ignore
      // this. The pretend camera has no head to look at, so without it the
      // challenge could never be answered outside a test.
      engine.asked?.(turn);
    } catch {
      // Whatever the camera managed to open before failing goes off again.
      engine.stop();
      if (run.current !== mine) {
        return;
      }
      setStage({
        name: 'refused',
        message: 'The camera would not start. Tell your supervisor.',
        offerFallback: false,
      });
      return;
    }
    if (run.current !== mine) {
      engine.stop();
      return;
    }
    await runChallenge(mine, direction, turn);
  }

  /**
   * Waits for the head to turn the way it was asked, then takes one centred
   * sample.
   *
   * This is what a printed photograph cannot do, and it is the kiosk's own job:
   * the server checks the numbers again but it cannot see the camera, so if this
   * is weak the whole thing is weak.
   */
  async function runChallenge(mine: number, direction: KioskDirection, turn: HeadTurn) {
    const deadline = Date.now() + challengeSeconds * 1000;
    let turned = false;

    while (Date.now() < deadline) {
      if (run.current !== mine) {
        return;
      }
      let reading: Awaited<ReturnType<FaceEngine['read']>>;
      try {
        reading = await engine.read();
      } catch {
        // A camera can be revoked mid-gesture. Without this the loop throws out
        // of an async function nobody awaits, and the screen sits on
        // "Follow the instruction" with nothing to press.
        engine.stop();
        if (run.current !== mine) {
          return;
        }
        setStage({
          name: 'refused',
          message: 'The camera stopped working. Tell your supervisor.',
          offerFallback: false,
        });
        return;
      }
      // `readingIsLive` on the turn as well as the sample. Checking only the
      // final frame would let one person do the head turn and a photograph
      // supply the face a moment later.
      if (!turned && reading.turnedTo === turn && readingIsLive(reading)) {
        turned = true;
        setStage({ name: 'challenging', direction, turn, turned: true });
      } else if (turned && readingIsUsable(reading)) {
        // Turned, then came back to centre, and this frame is good enough.
        await identify(mine, direction, reading.sample);
        return;
      }
      await wait(READ_EVERY_MILLISECONDS);
    }

    engine.stop();
    if (run.current !== mine) {
      return;
    }
    // A timeout is nobody's failed attempt: nothing reached the server, so it
    // does not move the server's own fallback unlock — but the person still
    // deserves the way to the fallbacks, which need the direction.
    refuse('That did not work. Stand square to the screen and try again.', direction);
  }

  async function identify(mine: number, direction: KioskDirection, sample: FaceSample) {
    setStage({ name: 'asking', direction });
    try {
      const answer = await callSigned<KioskIdentifyResponse>(device, 'kiosk/identify', {
        purpose: 'CLOCK',
        direction,
        sample,
      });
      engine.stop();
      if (run.current !== mine) {
        return;
      }
      if (answer.outcome !== 'MATCHED' || answer.worker === null) {
        // AMBIGUOUS, NOT_RECOGNISED and LOW_LIVENESS all say the same thing to
        // the person standing there. Telling them apart would tell a stranger
        // something about the faces we hold.
        countFailure('Not recognised. Please try again.', direction);
        return;
      }
      if (answer.fingerprint !== null) {
        // Face, then finger (`FACE_PASSKEY`): this worker has a key on this
        // kiosk, and the server will refuse a confirmation without the
        // assertion from it. Never confirm without one — the server refuses
        // anyway, and it would be a fallback around a second factor.
        setStage({
          name: 'fingerprinting',
          attemptId: answer.attemptId,
          displayName: answer.worker.displayName,
          direction,
        });
        await fingerThenConfirm(
          mine,
          answer.attemptId,
          requestOptionsFrom(answer.fingerprint.options),
          direction,
        );
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
      if (run.current !== mine) {
        return;
      }
      setStage(refusalFrom(error));
    }
  }

  /**
   * The device's sensor, then the punch. The options are the server's,
   * unchanged. A cancelled or unread finger is shown but **not counted**: the
   * server counts only attempts it saw fail, a cancelled finger leaves a
   * MATCHED attempt behind, and offering fallbacks the server has not
   * unlocked would walk the guard into one more refusal.
   */
  async function fingerThenConfirm(
    mine: number,
    attemptId: string,
    options: RequestOptionsJson,
    direction: KioskDirection,
  ) {
    try {
      const assertion = await getAssertion(options);
      if (run.current !== mine) {
        return;
      }
      await confirm(mine, attemptId, assertion);
    } catch (error) {
      if (run.current !== mine) {
        return;
      }
      refuse(error instanceof FingerprintRefused ? error.message : 'Please try again.', direction);
    }
  }

  /** The guard said nothing (or proved their finger), so the punch goes in. */
  async function confirm(mine: number, attemptId: string, assertion?: unknown) {
    setStage({ name: 'recording' });
    try {
      const punch = await callSigned<KioskPunchResponse>(device, 'kiosk/confirm', {
        attemptId,
        ...(assertion === undefined ? {} : { assertion }),
      });
      if (run.current !== mine) {
        return;
      }
      setFailures(0);
      setStage({ name: 'done', punch });
    } catch (error) {
      if (run.current !== mine) {
        return;
      }
      setStage(refusalFrom(error));
    }
  }

  /**
   * The guard pressed "Not me": the match is cancelled and counts as a failure.
   *
   * The stage changes **before** anything is awaited, and that ordering is the
   * whole correctness of this function. Leaving the greeting is what clears the
   * two-second confirm timer; awaiting first left it armed, so on a slow network
   * the timer fired and clocked in the very person who had just said this is not
   * them. That is the one outcome this button exists to prevent.
   */
  async function notMe(attemptId: string, direction?: KioskDirection) {
    // Leaving the greeting first is what clears the confirm timer, and
    // bumping the run retires a fingerprint read still waiting on the
    // sensor: its result must not confirm an attempt the guard has just
    // disowned — even if a whole new flow has started by the time it lands.
    run.current += 1;
    setStage({ name: 'cancelling' });
    try {
      await callSigned<void>(device, 'kiosk/not-me', { attemptId });
    } catch {
      // Once more; the server cancelling the match is what makes a lingering
      // finger sheet harmless, so one bad packet should not be the difference.
      try {
        await callSigned<void>(device, 'kiosk/not-me', { attemptId });
      } catch {
        // The guard still needs to get on with their shift either way.
      }
    }
    countFailure('Sorry about that. Please try again.', direction);
  }

  function countFailure(message: string, direction?: KioskDirection) {
    const nowFailed = failures + 1;
    setFailures(nowFailed);
    setStage({
      name: 'refused',
      message,
      offerFallback: nowFailed >= FAILURES_BEFORE_FALLBACK,
      direction,
    });
  }

  /**
   * A refusal that is nobody's failed attempt — a timeout the server never
   * saw, a finger sheet waved away. Shown the same, and the fallbacks are
   * still offered once real failures have unlocked them, but it never moves
   * the count itself: the count mirrors the server's own unlock rule.
   */
  function refuse(message: string, direction?: KioskDirection) {
    setStage({
      name: 'refused',
      message,
      offerFallback: failures >= FAILURES_BEFORE_FALLBACK,
      direction,
    });
  }

  function rest() {
    run.current += 1;
    engine.stop();
    setStage({ name: 'resting' });
  }

  if (stage.name === 'fallback') {
    // Its own screen, with its own camera element: the fallback may need the
    // supervisor's face, and mixing two flows into one stage machine is how
    // the wrong button ends up on the wrong screen.
    return (
      <FallbackScreen
        device={device}
        engine={engine}
        direction={stage.direction}
        onDone={(punch) => {
          setFailures(0);
          setStage({ name: 'done', punch });
        }}
        onCancel={rest}
      />
    );
  }

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>
          <BrandMark />
          SAMTEC
        </strong>
        {/* The way in for an administrator. Deliberately plain and small: it is
            not a secret door — the sign-in behind it is the real gate, and only
            an ADMIN can get through it — but a guard clocking in should never
            press it by accident. Hidden mid-attempt so nothing is abandoned
            half-done. */}
        {onAdmin !== undefined && stage.name === 'resting' ? (
          <button
            type="button"
            className="button button--quiet"
            style={{ width: 'auto', minHeight: 0, padding: '0.35rem 0.6rem', fontSize: '0.8em' }}
            onClick={onAdmin}
          >
            {device.name} · Admin
          </button>
        ) : (
          <span>{device.name}</span>
        )}
      </div>

      {/* The camera element stays mounted through every stage. Remounting it
          makes Android drop and re-request the camera, which takes seconds and
          sometimes asks permission again. */}
      <div
        className={`camera${stage.name === 'asking' || stage.name === 'recording' ? ' camera--reading' : ''}`}
        hidden={stage.name === 'resting' || stage.name === 'done'}
      >
        <video ref={video} playsInline muted autoPlay />
        <FaceGuide {...guideFor(stage)} />
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
        onConfirm={(attemptId) => void confirm(run.current, attemptId)}
        onNotMe={notMe}
        onFallback={(direction) => setStage({ name: 'fallback', direction })}
        onRest={rest}
        onSetUpAgain={onSetUpAgain}
      />
    </div>
  );
}

interface BodyProps {
  stage: Stage;
  showTheNameFor: number;
  onBegin: (direction: KioskDirection) => void;
  onConfirm: (attemptId: string) => void;
  onNotMe: (attemptId: string, direction?: KioskDirection) => void;
  onFallback: (direction: KioskDirection) => void;
  onRest: () => void;
  onSetUpAgain?: () => void;
}

function Body({
  stage,
  showTheNameFor,
  onBegin,
  onConfirm,
  onNotMe,
  onFallback,
  onRest,
  onSetUpAgain,
}: BodyProps) {
  // The name is shown for two seconds with a way out, then the punch goes in.
  // The wait is the whole point of "Not me": without it nobody could object.
  useEffect(() => {
    if (stage.name !== 'greeting') {
      return;
    }
    const timer = setTimeout(() => onConfirm(stage.attemptId), showTheNameFor);
    return () => clearTimeout(timer);
  }, [stage, showTheNameFor, onConfirm]);

  // An answer clears itself. This is a screen on a wall: the last guard's name
  // and whether they started or ended a shift used to sit there until somebody
  // pressed a button, telling everybody walking past who is on duty.
  useEffect(() => {
    if (stage.name !== 'done' && stage.name !== 'refused' && stage.name !== 'fingerprinting') {
      return;
    }
    const timer = setTimeout(
      onRest,
      stage.name === 'fingerprinting'
        ? CLEAR_A_WAITING_NAME_MILLISECONDS
        : CLEAR_THE_SCREEN_AFTER_MILLISECONDS,
    );
    return () => clearTimeout(timer);
  }, [stage, onRest]);

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
        <>
          <p className="notice notice--wait" role="status">
            {stage.turned
              ? 'Good. Look straight ahead and hold still.'
              : 'Follow the instruction on the camera.'}
          </p>
          <div className="buttons">
            {/* Twenty seconds is a long time to stand in the rain in front of a
                screen that has decided to wait. */}
            <button type="button" className="button button--quiet" onClick={onRest}>
              Cancel
            </button>
          </div>
        </>
      );

    case 'cancelling':
      return (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Cancelling…</p>
        </>
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
              onClick={() => onNotMe(stage.attemptId, stage.direction)}
            >
              Not me
            </button>
          </div>
        </>
      );

    case 'fingerprinting':
      return (
        <>
          <p className="greeting" role="status">
            Hello, {stage.displayName}
          </p>
          <p className="notice notice--wait">Touch the fingerprint sensor on this phone.</p>
          <div className="buttons">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => onNotMe(stage.attemptId, stage.direction)}
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
          <OutcomeMark outcome="good" />
          <h1>{stage.punch.direction === 'IN' ? 'Shift started' : 'Shift ended'}</h1>
          <p className="notice notice--good" role="status">
            Recorded for {stage.punch.worker.displayName}{' '}
            <span className="mono">({stage.punch.worker.staffNumber})</span> at{' '}
            <span className="mono">{timeInGhana(stage.punch.recordedAt)}</span>.{' '}
            {stage.punch.status === 'DUPLICATE'
              ? 'This was already recorded, so nothing was added twice.'
              : 'Have a good shift.'}
          </p>
          <p className="small muted">
            This is the time the server recorded, not this phone's clock.
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
          <OutcomeMark outcome="bad" />
          <p className="notice notice--bad" role="alert">
            {stage.message}
          </p>
          {stage.offerFallback && (
            <p className="notice notice--wait">Still not working? There are two other ways in.</p>
          )}
          <div className="buttons">
            {stage.offerFallback && stage.direction !== undefined && (
              <button
                type="button"
                className="button button--in"
                onClick={() => onFallback(stage.direction as KioskDirection)}
              >
                Another way in
              </button>
            )}
            <button type="button" className="button" onClick={onRest}>
              Start again
            </button>
            {stage.offerSetUpAgain === true && onSetUpAgain !== undefined && (
              <button type="button" className="button button--danger" onClick={onSetUpAgain}>
                Set this phone up again
              </button>
            )}
          </div>
        </>
      );
  }
}

/**
 * Turns a failed request into the refused stage.
 *
 * One function because a 401 can come back from any signed call, and the
 * recovery it needs is the same every time: this phone's key is wrong, or the
 * device has been switched off, and only an administrator setting it up again
 * gets past that. Written once when it lived in `confirm` alone, which meant a
 * 401 on `identify` — the first call a guard makes — left the phone stuck.
 */
function refusalFrom(error: unknown): Extract<Stage, { name: 'refused' }> {
  return {
    name: 'refused',
    message: error instanceof KioskRequestFailed ? error.message : 'Please try again.',
    offerFallback: false,
    offerSetUpAgain: error instanceof KioskRequestFailed && error.status === 401,
  };
}

/**
 * What the guide draws, for each stage of the flow.
 *
 * Kept as one function rather than conditions in the markup: the guide is the
 * only instruction a guard who does not read the sentence will get, so getting
 * the wrong shape on screen is worse than getting the wrong word.
 */
function guideFor(stage: Stage): { state: GuideState; turn?: HeadTurn | null } {
  switch (stage.name) {
    case 'challenging':
      return stage.turned ? { state: 'centre' } : { state: 'turn', turn: stage.turn };
    case 'asking':
    case 'recording':
    case 'cancelling':
      return { state: 'centre' };
    case 'greeting':
    case 'fingerprinting':
      return { state: 'good' };
    case 'refused':
      return { state: 'bad' };
    default:
      return { state: 'waiting' };
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The server's recorded moment, as a guard reads a clock.
 *
 * Ghana keeps UTC+0 all year, so this formats in UTC rather than the phone's own
 * zone — a phone set to the wrong zone must not make the kiosk disagree with the
 * dashboard about when somebody clocked in.
 */
function timeInGhana(isoMoment: string): string {
  const at = new Date(isoMoment);
  if (Number.isNaN(at.getTime())) {
    return isoMoment;
  }
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
