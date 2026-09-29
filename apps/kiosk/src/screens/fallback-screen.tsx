import type {
  KioskDirection,
  KioskFingerprintOptionsResponse,
  KioskIdentifyResponse,
  KioskPunchResponse,
  KioskWorker,
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
/** The contract's shape of a staff number, checked before a request is made. */
const STAFF_NUMBER = /^[A-Z]{2,4}-\d{2,6}$/;

/** Where the fallback is, on its way to one punch. */
type Stage =
  | { name: 'choosing' }
  | { name: 'number-form' }
  | { name: 'sensor'; worker: KioskWorker; attemptId: string }
  | { name: 'cosign-form' }
  | { name: 'cosign-challenge'; turn: HeadTurn; turned: boolean }
  | { name: 'asking' }
  | { name: 'recording' }
  | { name: 'failed'; message: string; canRetrySensor?: boolean };

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
 * screen shows word for word. Like the clock screen, nothing here ever shows a
 * score or says who a face looked like.
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
  const cancelled = useRef(false);
  // Held outside the stage: a sensor retry needs the same attempt and options,
  // and a co-sign confirmation needs the attempt after the stage moved on.
  const pending = useRef<{ attemptId: string; options: RequestOptionsJson } | null>(null);

  useEffect(() => {
    return () => {
      cancelled.current = true;
      engine.stop();
    };
  }, [engine]);

  /** The staff-number path: who they are, then the finger. */
  async function askForOptions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = staffNumber.trim().toUpperCase();
    if (!STAFF_NUMBER.test(typed)) {
      setProblem('Type the staff number as it is on the ID card, like GA-0007.');
      return;
    }
    setProblem(null);
    setStage({ name: 'asking' });
    try {
      const answer = await callSigned<KioskFingerprintOptionsResponse>(
        device,
        'kiosk/fingerprint-options',
        { staffNumber: typed, direction },
      );
      if (cancelled.current) {
        return;
      }
      // The contract's PasskeyRequestOptions is deliberately opaque; the JSON
      // shape it carries is the WebAuthn one `lib/passkeys.ts` translates.
      pending.current = {
        attemptId: answer.attemptId,
        options: requestOptionsFrom(answer.options),
      };
      setStage({ name: 'sensor', worker: answer.worker, attemptId: answer.attemptId });
      await readTheFinger(answer.attemptId, requestOptionsFrom(answer.options));
    } catch (error) {
      setStage(failedFrom(error));
    }
  }

  /** One sensor read, then the punch. Retryable while the attempt is fresh. */
  async function readTheFinger(attemptId: string, options: RequestOptionsJson) {
    try {
      const assertion = await getAssertion(options);
      if (cancelled.current) {
        return;
      }
      setStage({ name: 'recording' });
      const punch = await callSigned<KioskPunchResponse>(device, 'kiosk/confirm', {
        attemptId,
        assertion,
      });
      onDone(punch);
    } catch (error) {
      if (cancelled.current) {
        return;
      }
      if (error instanceof FingerprintRefused && error.cancelled) {
        // The attempt is only good for 60 seconds, so a retry is offered rather
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
      setProblem('Type the worker’s staff number, like GA-0007.');
      return;
    }
    if (reason.trim().length < 3) {
      setProblem('Say briefly why the worker cannot clock in themselves. It is recorded.');
      return;
    }
    setProblem(null);
    cancelled.current = false;
    const turn = randomHeadTurn();
    setStage({ name: 'cosign-challenge', turn, turned: false });
    try {
      if (video.current !== null) {
        await engine.start(video.current);
      }
      engine.asked?.(turn);
    } catch {
      setStage({ name: 'failed', message: 'The camera would not start. Tell your supervisor.' });
      return;
    }
    await superviserChallenge(typed, turn);
  }

  /** The same head turn a clock-in asks for, done by the supervisor. */
  async function superviserChallenge(workerStaffNumber: string, turn: HeadTurn) {
    const deadline = Date.now() + challengeSeconds * 1000;
    let turned = false;
    while (Date.now() < deadline) {
      if (cancelled.current) {
        return;
      }
      let reading: Awaited<ReturnType<FaceEngine['read']>>;
      try {
        reading = await engine.read();
      } catch {
        engine.stop();
        setStage({ name: 'failed', message: 'The camera stopped working. Start again.' });
        return;
      }
      if (!turned && reading.turnedTo === turn && readingIsLive(reading)) {
        turned = true;
        setStage({ name: 'cosign-challenge', turn, turned: true });
      } else if (turned && readingIsUsable(reading)) {
        await identifySupervisor(workerStaffNumber, reading.sample);
        return;
      }
      await wait(READ_EVERY_MILLISECONDS);
    }
    engine.stop();
    setStage({
      name: 'failed',
      message: 'That did not work. The supervisor should stand square to the screen and try again.',
    });
  }

  async function identifySupervisor(
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
      if (cancelled.current) {
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
        };
        setStage({ name: 'sensor', worker: answer.worker, attemptId: answer.attemptId });
        await coSignWithFinger(answer.attemptId, requestOptionsFrom(answer.fingerprint.options));
        return;
      }
      await recordCoSign(answer.attemptId, undefined);
    } catch (error) {
      engine.stop();
      setStage(failedFrom(error));
    }
  }

  async function coSignWithFinger(coSignAttemptId: string, options: RequestOptionsJson) {
    try {
      const assertion = await getAssertion(options);
      if (cancelled.current) {
        return;
      }
      await recordCoSign(coSignAttemptId, assertion);
    } catch (error) {
      if (cancelled.current) {
        return;
      }
      if (error instanceof FingerprintRefused && error.cancelled) {
        setStage({ name: 'failed', message: error.message, canRetrySensor: true });
        return;
      }
      setStage(failedFrom(error));
    }
  }

  async function recordCoSign(coSignAttemptId: string, assertion: unknown) {
    setStage({ name: 'recording' });
    try {
      const punch = await callSigned<KioskPunchResponse>(device, 'kiosk/assisted-punches', {
        coSignAttemptId,
        ...(assertion === undefined ? {} : { assertion }),
        reason: reason.trim(),
      });
      onDone(punch);
    } catch (error) {
      setStage(failedFrom(error));
    }
  }

  /** Offered only after the sensor itself was cancelled, while the attempt is fresh. */
  async function retrySensor() {
    const held = pending.current;
    if (held === null) {
      setStage({ name: 'choosing' });
      return;
    }
    setStage({ name: 'asking' });
    await readTheFinger(held.attemptId, held.options);
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
            <button type="button" className="button button--quiet" onClick={onCancel}>
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
              placeholder="GA-0007"
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
              placeholder="GA-0007"
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
                cancelled.current = true;
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
        <>
          <p className="greeting" role="status">
            {stage.worker.displayName}
          </p>
          <p className="notice notice--wait">Touch the fingerprint sensor on this phone.</p>
        </>
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
            <button type="button" className="button button--quiet" onClick={onCancel}>
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
