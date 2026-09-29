import type {
  KioskDirection,
  KioskFingerprintOptionsResponse,
  KioskIdentifyResponse,
  KioskPunchResponse,
} from '@samtec/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { FaceGuide } from '@/components/face-guide';
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

const READ_EVERY_MILLISECONDS = 200;
/** The contract's `StaffNumber`: `SMT-` and five digits, as printed on ID cards. */
const STAFF_NUMBER = /^SMT-\d{5}$/;
/** An attempt lives 60 seconds on the server; past ~55 a retry is pointless. */
const ATTEMPT_FRESH_MILLISECONDS = 55_000;
/** An idle fallback screen clears itself: it is a screen on a wall. */
const CLEAR_WHEN_IDLE_MILLISECONDS = 60_000;

/** Where the fallback is, on its way to one punch. */
type Stage =
  | { name: 'choosing' }
  | { name: 'number-form' }
  | { name: 'sensor' }
  | { name: 'cosign-form' }
  | { name: 'cosign-challenge'; turn: HeadTurn; turned: boolean }
  | { name: 'asking' }
  | { name: 'recording' }
  | { name: 'failed'; message: string; canRetrySensor?: boolean };

/** What a cancelled sensor read may pick up again, while the attempt lives. */
interface PendingFinger {
  attemptId: string;
  options: RequestOptionsJson;
  /** Which endpoint the finger belongs to: a confirm, or a co-sign punch. */
  flow: 'confirm' | 'cosign';
  startedAt: number;
}

interface FallbackScreenProps {
  device: PairedDevice;
  engine: FaceEngine;
  /** The direction of the clock-in that failed, carried over unchanged. */
  direction: KioskDirection;
  onDone: (punch: KioskPunchResponse) => void;
  onCancel: () => void;
  challengeSeconds?: number;
}

/**
 * The two ways in when the face has failed three times (docs/plan/13
 * sections 3 and 4).
 *
 * - **Staff number, then fingerprint.** The worker types who they are and the
 *   device's sensor proves a saved finger. The sensor can never say *whose*
 *   finger, so the punch is marked `STAFF_PASSKEY`, shows amber on the live
 *   board, and is counted by the ghost rules.
 * - **A supervisor's co-sign.** A site supervisor proves their own face (and
 *   their own finger, when they have one saved here), names the worker, and
 *   says why. The punch is marked `PIN_FALLBACK` and the reason is audited.
 *
 * The server owns every rule — who is unlocked, who qualifies, who may
 * co-sign — and refuses everything else with one neutral answer, which this
 * screen shows word for word. Like the clock screen, nothing here ever shows
 * a score, says who a face looked like, **or turns a typed staff number into
 * a name**: anyone can stand at a kiosk and type numbers, so a name appears
 * only once a punch has actually been recorded.
 */
export function FallbackScreen({
  device,
  engine,
  direction,
  onDone,
  onCancel,
  challengeSeconds = CHALLENGE_SECONDS,
}: FallbackScreenProps) {
  const [stage, setStage] = useState<Stage>({ name: 'choosing' });
  const [staffNumber, setStaffNumber] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  /** The living flow, as on the clock screen: every await re-checks it. */
  const run = useRef(0);
  const pending = useRef<PendingFinger | null>(null);

  useEffect(() => {
    run.current += 1;
    return () => {
      run.current += 1;
      engine.stop();
    };
  }, [engine]);

  // A wall screen clears itself. Typing stages are exempt — a person is
  // mid-thought there — but a waiting sensor, an untouched chooser or a
  // refusal must not sit forever with the last worker's business on show.
  useEffect(() => {
    if (stage.name !== 'sensor' && stage.name !== 'failed' && stage.name !== 'choosing') {
      return;
    }
    const timer = setTimeout(onCancel, CLEAR_WHEN_IDLE_MILLISECONDS);
    return () => clearTimeout(timer);
  }, [stage, onCancel]);

  /** The staff-number path: who they are, then the finger. */
  async function askForOptions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = staffNumber.trim().toUpperCase();
    if (!STAFF_NUMBER.test(typed)) {
      setProblem('Type the staff number as it is on the ID card, like SMT-00042.');
      return;
    }
    const mine = ++run.current;
    setProblem(null);
    setStage({ name: 'asking' });
    try {
      const answer = await callSigned<KioskFingerprintOptionsResponse>(
        device,
        'kiosk/fingerprint-options',
        { staffNumber: typed, direction },
      );
      if (run.current !== mine) {
        return;
      }
      pending.current = {
        attemptId: answer.attemptId,
        options: requestOptionsFrom(answer.options),
        flow: 'confirm',
        startedAt: Date.now(),
      };
      setStage({ name: 'sensor' });
      await readTheFinger(mine, pending.current);
    } catch (error) {
      if (run.current !== mine) {
        return;
      }
      setStage(failedFrom(error));
    }
  }

  /** One sensor read, then the punch. Retryable while the attempt is fresh. */
  async function readTheFinger(mine: number, finger: PendingFinger) {
    try {
      const assertion = await getAssertion(finger.options);
      if (run.current !== mine) {
        return;
      }
      setStage({ name: 'recording' });
      const punch =
        finger.flow === 'confirm'
          ? await callSigned<KioskPunchResponse>(device, 'kiosk/confirm', {
              attemptId: finger.attemptId,
              assertion,
            })
          : await callSigned<KioskPunchResponse>(device, 'kiosk/assisted-punches', {
              coSignAttemptId: finger.attemptId,
              assertion,
              reason: reason.trim(),
            });
      if (run.current !== mine) {
        return;
      }
      finish(punch);
    } catch (error) {
      if (run.current !== mine) {
        return;
      }
      if (error instanceof FingerprintRefused && error.cancelled) {
        // The attempt is only good for a minute, so a retry is offered rather
        // than looped into: the person decides, not a timer.
        setStage({ name: 'failed', message: error.message, canRetrySensor: true });
        return;
      }
      setStage(failedFrom(error));
    }
  }

  /** The co-sign path: the worker named, the reason given, then the supervisor's face. */
  async function beginCoSign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = staffNumber.trim().toUpperCase();
    if (!STAFF_NUMBER.test(typed)) {
      setProblem('Type the worker’s staff number, like SMT-00042.');
      return;
    }
    if (reason.trim().length < 3) {
      setProblem('Say briefly why the worker cannot clock in themselves. It is recorded.');
      return;
    }
    setProblem(null);
    const mine = ++run.current;
    const turn = randomHeadTurn();
    setStage({ name: 'cosign-challenge', turn, turned: false });
    try {
      if (video.current !== null) {
        await engine.start(video.current);
      }
      engine.asked?.(turn);
    } catch {
      engine.stop();
      if (run.current !== mine) {
        return;
      }
      setStage({ name: 'failed', message: 'The camera would not start. Tell your supervisor.' });
      return;
    }
    if (run.current !== mine) {
      engine.stop();
      return;
    }
    await superviserChallenge(mine, typed, turn);
  }

  /** The same head turn a clock-in asks for, done by the supervisor. */
  async function superviserChallenge(mine: number, workerStaffNumber: string, turn: HeadTurn) {
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
        engine.stop();
        if (run.current !== mine) {
          return;
        }
        setStage({ name: 'failed', message: 'The camera stopped working. Start again.' });
        return;
      }
      if (!turned && reading.turnedTo === turn && readingIsLive(reading)) {
        turned = true;
        setStage({ name: 'cosign-challenge', turn, turned: true });
      } else if (turned && readingIsUsable(reading)) {
        await identifySupervisor(mine, workerStaffNumber, reading.sample);
        return;
      }
      await wait(READ_EVERY_MILLISECONDS);
    }
    engine.stop();
    if (run.current !== mine) {
      return;
    }
    setStage({
      name: 'failed',
      message: 'That did not work. The supervisor should stand square to the screen and try again.',
    });
  }

  async function identifySupervisor(
    mine: number,
    workerStaffNumber: string,
    sample: NonNullable<Awaited<ReturnType<FaceEngine['read']>>['sample']>,
  ) {
    setStage({ name: 'asking' });
    try {
      const answer = await callSigned<KioskIdentifyResponse>(device, 'kiosk/identify', {
        purpose: 'CO_SIGN',
        staffNumber: workerStaffNumber,
        direction,
        sample,
      });
      engine.stop();
      if (run.current !== mine) {
        return;
      }
      if (answer.outcome !== 'MATCHED' || answer.worker === null) {
        setStage({ name: 'failed', message: 'The supervisor was not recognised. Try again.' });
        return;
      }
      if (answer.fingerprint !== null) {
        // The supervisor has a key on this kiosk, so their finger is required
        // too — their face alone must not hand out punches once a key exists.
        pending.current = {
          attemptId: answer.attemptId,
          options: requestOptionsFrom(answer.fingerprint.options),
          flow: 'cosign',
          startedAt: Date.now(),
        };
        setStage({ name: 'sensor' });
        await readTheFinger(mine, pending.current);
        return;
      }
      setStage({ name: 'recording' });
      const punch = await callSigned<KioskPunchResponse>(device, 'kiosk/assisted-punches', {
        coSignAttemptId: answer.attemptId,
        reason: reason.trim(),
      });
      if (run.current !== mine) {
        return;
      }
      finish(punch);
    } catch (error) {
      engine.stop();
      if (run.current !== mine) {
        return;
      }
      setStage(failedFrom(error));
    }
  }

  /**
   * Offered only after the sensor itself was cancelled. The retry re-enters
   * the flow the attempt belongs to — a co-sign's finger goes back to the
   * co-sign punch, never to `kiosk/confirm` — and only while the attempt is
   * still fresh on the server; after that, back to the start honestly.
   */
  async function retrySensor() {
    const held = pending.current;
    if (held === null || Date.now() - held.startedAt > ATTEMPT_FRESH_MILLISECONDS) {
      pending.current = null;
      setStage({ name: 'choosing' });
      return;
    }
    const mine = ++run.current;
    setStage({ name: 'sensor' });
    await readTheFinger(mine, held);
  }

  /** One exit for a recorded punch: nothing typed here outlives it. */
  function finish(punch: KioskPunchResponse) {
    setStaffNumber('');
    setReason('');
    pending.current = null;
    onDone(punch);
  }

  /** One exit for walking away: nothing typed here survives on the wall. */
  function leave() {
    run.current += 1;
    engine.stop();
    setStaffNumber('');
    setReason('');
    pending.current = null;
    onCancel();
  }

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>
          <BrandMark />
          SAMTEC
        </strong>
        <span>{device.name} · Another way in</span>
      </div>

      <div className="camera" hidden={stage.name !== 'cosign-challenge'}>
        <video ref={video} playsInline muted autoPlay />
        <FaceGuide
          state={stage.name === 'cosign-challenge' && !stage.turned ? 'turn' : 'centre'}
          turn={stage.name === 'cosign-challenge' && !stage.turned ? stage.turn : null}
        />
        {stage.name === 'cosign-challenge' && (
          <p className="camera__instruction">
            {stage.turned ? 'Now look straight ahead' : headTurnInstruction(stage.turn)}
          </p>
        )}
      </div>

      {stage.name === 'choosing' && (
        <>
          <h1>Another way in</h1>
          <p className="muted">The face check did not work. There are two other ways.</p>
          <div className="buttons">
            <button
              type="button"
              className="button button--in"
              onClick={() => {
                setProblem(null);
                setStage({ name: 'number-form' });
              }}
            >
              My staff number and my fingerprint
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setProblem(null);
                setStage({ name: 'cosign-form' });
              }}
            >
              A supervisor clocks me in
            </button>
            <button type="button" className="button button--quiet" onClick={leave}>
              Back
            </button>
          </div>
        </>
      )}

      {stage.name === 'number-form' && (
        <form noValidate onSubmit={askForOptions} className="buttons" style={{ maxWidth: '30rem' }}>
          <h1>Who are you?</h1>
          <div className="field">
            <label htmlFor="fallback-staff-number">Your staff number</label>
            <input
              id="fallback-staff-number"
              className="mono"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="SMT-00042"
              value={staffNumber}
              onChange={(event) => setStaffNumber(event.target.value)}
            />
          </div>
          <p className="small muted">
            Your fingerprint on this phone is asked for next. This clock-in is marked as a fallback
            and checked.
          </p>
          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}
          <button type="submit" className="button button--in">
            Continue to the fingerprint
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setStage({ name: 'choosing' })}
          >
            Back
          </button>
        </form>
      )}

      {stage.name === 'cosign-form' && (
        <form noValidate onSubmit={beginCoSign} className="buttons" style={{ maxWidth: '30rem' }}>
          <h1>Supervisor clock-in</h1>
          <div className="field">
            <label htmlFor="cosign-staff-number">The worker&rsquo;s staff number</label>
            <input
              id="cosign-staff-number"
              className="mono"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="SMT-00042"
              value={staffNumber}
              onChange={(event) => setStaffNumber(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cosign-reason">Why can&rsquo;t they clock in themselves?</label>
            <input
              id="cosign-reason"
              autoComplete="off"
              maxLength={200}
              placeholder="Face not recognised"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <p className="small muted">
            The supervisor for this site proves their own face next. The reason is recorded with
            their name.
          </p>
          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}
          <button type="submit" className="button button--in">
            Supervisor: prove your face
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setStage({ name: 'choosing' })}
          >
            Back
          </button>
        </form>
      )}

      {stage.name === 'cosign-challenge' && (
        <>
          <p className="notice notice--wait" role="status">
            {stage.turned
              ? 'Good. Look straight ahead and hold still.'
              : 'Supervisor: follow the instruction on the camera.'}
          </p>
          <div className="buttons">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                run.current += 1;
                engine.stop();
                setStage({ name: 'choosing' });
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.name === 'sensor' && (
        // No name here, on purpose: a typed number must never become a name
        // on a wall. The name appears once the punch is recorded, when the
        // person has proved a finger — not merely guessed a number.
        <p className="notice notice--wait" role="status">
          Touch the fingerprint sensor on this phone.
        </p>
      )}

      {stage.name === 'asking' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Checking…</p>
        </>
      )}

      {stage.name === 'recording' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Recording…</p>
        </>
      )}

      {stage.name === 'failed' && (
        <>
          <OutcomeMark outcome="bad" />
          <p className="notice notice--bad" role="alert">
            {stage.message}
          </p>
          <div className="buttons">
            {stage.canRetrySensor === true && (
              <button type="button" className="button button--in" onClick={() => retrySensor()}>
                Try the fingerprint again
              </button>
            )}
            <button type="button" className="button" onClick={() => setStage({ name: 'choosing' })}>
              Start again
            </button>
            <button type="button" className="button button--quiet" onClick={leave}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A failed request in this screen's terms: the server's words, or a plain retry. */
function failedFrom(error: unknown): Extract<Stage, { name: 'failed' }> {
  return {
    name: 'failed',
    message:
      error instanceof KioskRequestFailed
        ? error.message
        : error instanceof FingerprintRefused
          ? error.message
          : 'Please try again.',
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
