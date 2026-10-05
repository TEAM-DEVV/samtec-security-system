import type {
  BiometricConsent,
  BiometricConsentText,
  DevicePasskey,
  EmployeeList,
  FaceEnrollmentResult,
  FaceSample,
  PasskeyOptionsResponse,
} from '@samtec/contracts';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { CaptureDots } from '@/components/capture-dots';
import { FaceGuide } from '@/components/face-guide';
import { OutcomeMark } from '@/components/outcome-mark';
import type { AdminSession } from '@/lib/admin-session';
import { callSigned, KioskRequestFailed } from '@/lib/api';
import type { PairedDevice } from '@/lib/device';
import {
  CHALLENGE_SECONDS,
  type FaceEngine,
  type HeadTurn,
  headTurnInstruction,
  hintFor,
  randomHeadTurn,
  readingIsLive,
  readingIsUsable,
} from '@/lib/face';
import {
  createPasskey,
  creationOptionsFrom,
  FingerprintRefused,
  passkeysAvailable,
} from '@/lib/passkeys';

/** The contract wants exactly three captures. */
const CAPTURES_NEEDED = 3;
/** The design's spacing between them, so the three frames are not one frame. */
const BETWEEN_CAPTURES_MILLISECONDS = 500;
/** The last four digits of the Ghana Card, as the contract asks. */
const CARD_LAST_4 = /^\d{4}$/;
const READ_EVERY_MILLISECONDS = 200;

/** Where this screen is. */
type Stage =
  | { name: 'choosing' }
  | { name: 'consenting' }
  | { name: 'recording-consent' }
  | { name: 'capturing'; taken: number; instruction: string; turn: HeadTurn; hint: string | null }
  | { name: 'sending' }
  | { name: 'enrolled'; result: FaceEnrollmentResult }
  | { name: 'finger-asking' }
  | { name: 'finger-sensor' }
  | { name: 'finger-saving' }
  | { name: 'finger-saved'; passkey: DevicePasskey }
  | { name: 'finger-cancelled' }
  | { name: 'failed'; message: string };

/**
 * Which job the worker picker is doing: putting a new face on file, or saving
 * a fingerprint for somebody whose face is already in use. Two lists, because
 * the two jobs start from opposite states — `PENDING_ENROLLMENT` has no face
 * yet, and a fingerprint may only be saved once a face is `ACTIVE`.
 */
export type Task = 'enroll' | 'finger';

interface EnrollScreenProps {
  device: PairedDevice;
  admin: AdminSession;
  engine: FaceEngine;
  onDone: () => void;
  /**
   * Which job to open on, so the admin menu's "Save a fingerprint" item can
   * jump straight to the finger task instead of landing on the face task and
   * making the administrator switch.
   */
  initialTask?: Task;
  /**
   * Whether this device allows fingerprints (the dashboard's switch, learned
   * from the heartbeat). When it is off the server refuses every fingerprint,
   * so the screen must not offer one.
   */
  fingerprintsAllowed?: boolean;
  /** Overridable so a test does not sit through three real half-second waits. */
  betweenCaptures?: number;
  challengeSeconds?: number;
}

/**
 * Putting a worker on the system: their consent, then their face.
 *
 * Both steps need **an administrator signed in on this kiosk and the kiosk's own
 * signature**. A stolen password cannot enrol anybody, and neither can a stolen
 * kiosk (docs/plan/13 section 2).
 *
 * Two rules this screen exists to honour:
 *
 * - **The consent words come from the server and are shown exactly as sent.** The
 *   record stores which version was agreed to and its fingerprint, so the company
 *   can show later what a worker actually read. A kiosk that paraphrased them
 *   would make that record a lie.
 * - **A collision says only "needs an admin review".** When a new face looks like
 *   somebody already enrolled, naming them would tell whoever is standing there
 *   who else works for this company, which is exactly the thing a biometric system
 *   must not leak.
 */
export function EnrollScreen({
  device,
  admin,
  engine,
  onDone,
  initialTask = 'enroll',
  fingerprintsAllowed = true,
  betweenCaptures = BETWEEN_CAPTURES_MILLISECONDS,
  challengeSeconds = CHALLENGE_SECONDS,
}: EnrollScreenProps) {
  // Offered only when the device allows it and the browser has a sensor API.
  const offerFingerprints = fingerprintsAllowed && passkeysAvailable();
  const [stage, setStage] = useState<Stage>({ name: 'choosing' });
  const [task, setTask] = useState<Task>(initialTask);
  const [employeeId, setEmployeeId] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [agreed, setAgreed] = useState(false);
  /**
   * The consent already recorded for `employeeId`, so a capture that fails
   * (a timed-out turn, bad light) can be tried again without marching the
   * worker back through the wording and the card digits. Cleared whenever
   * the screen returns to choosing a worker.
   */
  const [recordedConsentId, setRecordedConsentId] = useState<string | null>(null);
  const [consentText, setConsentText] = useState<BiometricConsentText | null>(null);
  const [waiting, setWaiting] = useState<EmployeeList['items']>([]);
  const [enrolled, setEnrolled] = useState<EmployeeList['items']>([]);
  /**
   * Whether the two worker lists have actually come back. Both start empty,
   * same as a list with nobody on it, so without this flag the "nobody
   * waiting" message showed for an instant on every visit, while the request
   * was still in flight.
   */
  const [workersLoaded, setWorkersLoaded] = useState(false);
  // Set when the lists could not be read, so the screen stops saying it is
  // still reading them: the error underneath is the whole story then.
  const [loadFailed, setLoadFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    // Re-armed on every mount: development StrictMode mounts, cleans up and
    // mounts again, and a flag left true from the first pass silently
    // swallowed every flow of the second.
    cancelled.current = false;
    void engine.prepare?.().catch(() => undefined);
    return () => {
      cancelled.current = true;
      engine.stop();
    };
  }, [engine]);

  // The official wording, and the people who still need enrolling. Both are read
  // with the administrator's token: the kiosk itself may not list employees.
  useEffect(() => {
    let live = true;
    const base = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${admin.accessToken}` };
    void Promise.all([
      fetch(`${base}/biometrics/consent-text`, { headers }).then((answer) => answer.json()),
      fetch(`${base}/employees?status=PENDING_ENROLLMENT&limit=100`, { headers }).then((answer) =>
        answer.json(),
      ),
      // For saving a fingerprint: only somebody whose face is already in use
      // qualifies, and the server enforces exactly that on the options call.
      fetch(`${base}/employees?status=ACTIVE&limit=100`, { headers }).then((answer) =>
        answer.json(),
      ),
    ])
      .then(([text, pending, active]: [BiometricConsentText, EmployeeList, EmployeeList]) => {
        if (live) {
          setConsentText(text);
          setWaiting(pending.items ?? []);
          setEnrolled(active.items ?? []);
          setWorkersLoaded(true);
        }
      })
      .catch(() => {
        if (live) {
          setLoadFailed(true);
          setProblem('Could not load the consent wording. Check the connection and try again.');
        }
      });
    return () => {
      live = false;
    };
  }, [admin.accessToken]);

  async function recordConsent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.name === 'recording-consent' || consentText === null) {
      return;
    }
    if (!CARD_LAST_4.test(cardLast4)) {
      setProblem('Type the last four digits of the Ghana Card.');
      return;
    }
    if (!agreed) {
      setProblem('The worker has to agree before anything is recorded.');
      return;
    }
    setProblem(null);
    setStage({ name: 'recording-consent' });
    try {
      const consent = await callSigned<BiometricConsent>(
        device,
        'kiosk/consents',
        { employeeId, ghanaCardLast4: cardLast4, textVersion: consentText.version },
        admin.accessToken,
      );
      // The card digits have done their job. Nothing on a kiosk should keep part
      // of somebody's Ghana Card number a moment longer than it is needed.
      setCardLast4('');
      setRecordedConsentId(consent.id);
      await captureThreeFaces(consent.id);
    } catch (error) {
      setStage({
        name: 'failed',
        message: error instanceof KioskRequestFailed ? error.message : 'Please try again.',
      });
    }
  }

  /**
   * Three captures, half a second apart, each after its own head turn.
   *
   * A turn per capture rather than one for all three: three frames of the same
   * pose half a second apart are nearly the same frame, and the server checks the
   * three agree with each other. Asking again each time gives three genuinely
   * different looks at a live face.
   */
  async function captureThreeFaces(consentId: string) {
    // Re-armed on every attempt, the same as the mount effect above: a flag
    // left true by an earlier cancelled attempt (this one, or a cancelled
    // fingerprint) must not silently swallow a fresh one.
    cancelled.current = false;
    const samples: FaceSample[] = [];
    try {
      if (video.current !== null) {
        await engine.start(video.current);
      }
    } catch {
      // Whatever the camera managed to open before failing goes off again.
      engine.stop();
      setStage({ name: 'failed', message: 'The camera would not start. Try again.' });
      return;
    }

    while (samples.length < CAPTURES_NEEDED) {
      const turn = randomHeadTurn();
      setStage({
        name: 'capturing',
        taken: samples.length,
        instruction: headTurnInstruction(turn),
        turn,
        hint: null,
      });
      engine.asked?.(turn);

      const sample = await oneCapture(turn, challengeSeconds);
      if (cancelled.current) {
        return;
      }
      if (sample === null) {
        engine.stop();
        setStage({
          name: 'failed',
          message: 'That did not work. Stand square to the screen, in good light, and try again.',
        });
        return;
      }
      samples.push(sample);
      if (samples.length < CAPTURES_NEEDED) {
        await wait(betweenCaptures);
      }
    }

    engine.stop();
    setStage({ name: 'sending' });
    try {
      const result = await callSigned<FaceEnrollmentResult>(
        device,
        'kiosk/face-enrollments',
        { employeeId, consentId, samples },
        admin.accessToken,
      );
      setStage({ name: 'enrolled', result });
    } catch (error) {
      setStage({
        name: 'failed',
        message: error instanceof KioskRequestFailed ? error.message : 'Please try again.',
      });
    }
  }

  /**
   * Saves the chosen worker's fingerprint on this phone.
   *
   * Three steps, and the middle one is the phone's own: the server's options go
   * to the built-in sensor unchanged, the worker enrolls a finger the phone
   * already knows, and only the **public half** of the key comes back. SAMTEC
   * never holds a fingerprint — the finger stays in the phone's own secure
   * hardware (docs/plan/13 section 4).
   */
  async function saveFinger(workerId: string) {
    // Re-armed here too (see `captureThreeFaces`): an administrator who
    // cancelled an earlier fingerprint must still be able to start a new one.
    cancelled.current = false;
    setProblem(null);
    setStage({ name: 'finger-asking' });
    try {
      const offered = await callSigned<PasskeyOptionsResponse>(
        device,
        'kiosk/passkey-options',
        { employeeId: workerId },
        admin.accessToken,
      );
      if (cancelled.current) {
        return;
      }
      setStage({ name: 'finger-sensor' });
      const response = await createPasskey(creationOptionsFrom(offered.options));
      if (cancelled.current) {
        return;
      }
      // From here the finger is already proven and the save is on its way:
      // no Cancel, because "not saved" could no longer be promised.
      setStage({ name: 'finger-saving' });
      const passkey = await callSigned<DevicePasskey>(
        device,
        'kiosk/passkeys',
        { employeeId: workerId, ticket: offered.ticket, response },
        admin.accessToken,
      );
      if (cancelled.current) {
        return;
      }
      setStage({ name: 'finger-saved', passkey });
    } catch (error) {
      if (cancelled.current) {
        return;
      }
      setStage({
        name: 'failed',
        message:
          error instanceof KioskRequestFailed || error instanceof FingerprintRefused
            ? error.message
            : 'Please try again.',
      });
    }
  }

  /**
   * Abandons the fingerprint step: the sensor or the server may still answer
   * later, but the same guard `captureThreeFaces` uses makes sure that answer
   * is ignored. The face enrollment this led here from, if any, is a separate
   * record already saved on the server and is untouched by this.
   */
  function cancelFingerprint() {
    cancelled.current = true;
    setStage({ name: 'finger-cancelled' });
  }

  /**
   * Stops the camera and abandons a capture in progress. The consent already
   * recorded is not touched, so "Try the face again" on the stage this leads
   * to goes straight back to the camera.
   */
  function cancelCapturing() {
    cancelled.current = true;
    engine.stop();
    setStage({ name: 'failed', message: 'Capture cancelled.' });
  }

  /** One head turn, then one centred frame, or `null` when the time runs out. */
  async function oneCapture(turn: 'LEFT' | 'RIGHT', seconds: number): Promise<FaceSample | null> {
    const deadline = Date.now() + seconds * 1000;
    let turned = false;
    while (Date.now() < deadline) {
      if (cancelled.current) {
        return null;
      }
      let reading: Awaited<ReturnType<FaceEngine['read']>>;
      try {
        reading = await engine.read();
      } catch {
        return null;
      }
      if (!turned && reading.turnedTo === turn && readingIsLive(reading)) {
        turned = true;
        setStage((current) =>
          current.name === 'capturing' ? { ...current, hint: null } : current,
        );
      } else if (turned && readingIsUsable(reading)) {
        return reading.sample;
      } else {
        const hint = hintFor(reading, turned);
        setStage((current) =>
          current.name === 'capturing' && current.hint !== hint ? { ...current, hint } : current,
        );
      }
      await wait(READ_EVERY_MILLISECONDS);
    }
    return null;
  }

  const pickFrom = task === 'enroll' ? waiting : enrolled;
  const chosen = pickFrom.find((one) => one.id === employeeId);

  return (
    <div className="screen screen--centred">
      <div className="bar" style={{ width: '100%', maxWidth: '30rem' }}>
        <strong>
          <BrandMark />
          SAMTEC
        </strong>
        <span>Enrolling · {admin.fullName}</span>
      </div>

      <div className="camera" hidden={stage.name !== 'capturing'}>
        <video ref={video} playsInline muted autoPlay />
        {/* The same oval and arrow the clock-in screen uses, so a worker being
            enrolled learns the gesture they will use every day from now on. */}
        <FaceGuide state="turn" turn={stage.name === 'capturing' ? stage.turn : null} />
        {stage.name === 'capturing' && <p className="camera__instruction">{stage.instruction}</p>}
      </div>

      {stage.name === 'choosing' && (
        <>
          <h1>{task === 'enroll' ? 'Who is being enrolled?' : 'Whose fingerprint?'}</h1>
          <div className="field">
            <label htmlFor="enroll-employee">Worker</label>
            <select
              id="enroll-employee"
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              className="mono"
              style={{
                minHeight: '3rem',
                borderRadius: '0.6rem',
                padding: '0.85rem 0.9rem',
                background: 'var(--bg)',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
                font: 'inherit',
              }}
            >
              <option value="">Choose a worker</option>
              {pickFrom.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.staffNumber} · {one.fullName}
                </option>
              ))}
            </select>
          </div>
          {!workersLoaded && !loadFailed && <p className="muted">Reading the worker list…</p>}
          {workersLoaded && pickFrom.length === 0 && (
            <p className="notice notice--wait">
              {task === 'enroll'
                ? 'Nobody is waiting to be enrolled. Register the worker on the dashboard first.'
                : 'Nobody has a face in use yet. A fingerprint is saved only after the face works.'}
            </p>
          )}
          {task === 'finger' && (
            <p className="small muted">
              The worker&rsquo;s finger must already be saved in this phone&rsquo;s own settings.
              The phone keeps the finger; SAMTEC keeps only a key it unlocks.
            </p>
          )}
          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}
          <div className="buttons">
            <button
              type="button"
              className="button button--in"
              disabled={employeeId === '' || (task === 'enroll' && consentText === null)}
              onClick={() => {
                if (task === 'enroll') {
                  setStage({ name: 'consenting' });
                } else {
                  void saveFinger(employeeId);
                }
              }}
            >
              {task === 'enroll' ? 'Continue' : 'Save their fingerprint'}
            </button>
            {offerFingerprints && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  setEmployeeId('');
                  setProblem(null);
                  setTask(task === 'enroll' ? 'finger' : 'enroll');
                }}
              >
                {task === 'enroll'
                  ? 'Save a fingerprint instead (already enrolled)'
                  : 'Back to enrolling a face'}
              </button>
            )}
            <button type="button" className="button button--quiet" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      )}

      {stage.name === 'consenting' && consentText !== null && (
        <form noValidate onSubmit={recordConsent} className="buttons" style={{ maxWidth: '34rem' }}>
          <h1>Read this to {chosen?.fullName ?? 'the worker'}</h1>
          {/* The server's exact words. Never paraphrased: the record says which
              version was agreed to, and that has to be true. */}
          <div
            className="notice"
            style={{ whiteSpace: 'pre-wrap', maxHeight: '18rem', overflowY: 'auto' }}
          >
            {consentText.text}
          </div>
          <p className="small muted">
            Version <span className="mono">{consentText.version}</span>
          </p>

          <div className="field">
            <label htmlFor="enroll-card">Last 4 digits of their Ghana Card</label>
            <input
              id="enroll-card"
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={cardLast4}
              onChange={(event) => setCardLast4(event.target.value.replace(/\D/g, ''))}
            />
          </div>

          <label
            className="notice"
            style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              style={{ width: '1.5rem', height: '1.5rem' }}
            />
            <span>They have read this, or had it read to them, and they agree.</span>
          </label>

          {problem !== null && (
            <p className="notice notice--bad" role="alert">
              {problem}
            </p>
          )}

          <button type="submit" className="button button--in">
            Record consent and take their face
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

      {stage.name === 'recording-consent' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Recording their consent…</p>
        </>
      )}

      {stage.name === 'capturing' && (
        <>
          <CaptureDots taken={stage.taken} needed={CAPTURES_NEEDED} />
          <p className="notice notice--wait" role="status">
            Capture {stage.taken + 1} of {CAPTURES_NEEDED}. Follow the instruction on the camera,
            then look straight ahead.
          </p>
          {stage.hint !== null && (
            <p className="muted" role="status">
              {stage.hint}
            </p>
          )}
          <div className="buttons">
            <button type="button" className="button button--quiet" onClick={cancelCapturing}>
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.name === 'sending' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Saving their face…</p>
        </>
      )}

      {stage.name === 'enrolled' && (
        <>
          <OutcomeMark outcome={stage.result.dedupe === 'PASSED' ? 'good' : 'waiting'} />
          <h1>{stage.result.dedupe === 'PASSED' ? 'Enrolled' : 'Needs an admin review'}</h1>
          <p
            className={
              stage.result.dedupe === 'PASSED' ? 'notice notice--good' : 'notice notice--wait'
            }
            role="status"
          >
            {stage.result.dedupe === 'PASSED'
              ? `${chosen?.fullName ?? 'This worker'} can now clock in with their face.${
                  offerFingerprints
                    ? ' Save their fingerprint now: without it, they clock in on face alone.'
                    : ''
                }`
              : // Never who it looked like. Whoever is standing here must not learn
                // who else works for this company.
                'This face looks like someone already enrolled. An administrator can review it on the dashboard under Duplicate faces. Once that is cleared, a fingerprint can be saved for them here.'}
          </p>
          {!stage.result.postedHere && (
            // A kiosk only recognises workers posted to its own site. Said
            // now, while the administrator is still standing here, rather
            // than discovered later as a face that "does not work".
            <p className="notice notice--wait" role="status">
              {chosen?.fullName ?? 'This worker'} is not posted to this kiosk’s site, so they cannot
              clock in here yet. Post them on the dashboard: Employees →{' '}
              {chosen?.fullName ?? 'the worker'} → Edit → Current site.
            </p>
          )}
          <div className="buttons">
            {stage.result.dedupe === 'PASSED' && offerFingerprints && (
              <button
                type="button"
                className="button button--in"
                onClick={() => void saveFinger(employeeId)}
              >
                Save their fingerprint on this phone
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={() => {
                setEmployeeId('');
                setAgreed(false);
                setRecordedConsentId(null);
                setStage({ name: 'choosing' });
              }}
            >
              Enrol somebody else
            </button>
            <button type="button" className="button button--quiet" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      )}

      {stage.name === 'finger-asking' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Talking to the system…</p>
          <div className="buttons">
            <button type="button" className="button button--quiet" onClick={cancelFingerprint}>
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.name === 'finger-sensor' && (
        <>
          <p className="notice notice--wait" role="status">
            The worker now touches the fingerprint sensor on this phone, with a finger already saved
            in the phone&rsquo;s settings.
          </p>
          <div className="buttons">
            <button type="button" className="button button--quiet" onClick={cancelFingerprint}>
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.name === 'finger-saving' && (
        <>
          <div className="spinner" aria-hidden="true" />
          <p role="status">Saving their fingerprint…</p>
        </>
      )}

      {stage.name === 'finger-cancelled' && (
        <>
          <h1>Fingerprint not saved</h1>
          <p className="notice notice--wait" role="status">
            {chosen?.fullName ?? 'This worker'}’s face enrollment is already saved. Try the
            fingerprint again whenever the sensor is ready.
          </p>
          <div className="buttons">
            <button
              type="button"
              className="button button--in"
              onClick={() => void saveFinger(employeeId)}
            >
              Try the fingerprint again
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setEmployeeId('');
                setAgreed(false);
                setRecordedConsentId(null);
                setStage({ name: 'choosing' });
              }}
            >
              Enrol somebody else
            </button>
            <button type="button" className="button button--quiet" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      )}

      {stage.name === 'finger-saved' && (
        <>
          <OutcomeMark outcome="good" />
          <h1>Fingerprint saved</h1>
          <p className="notice notice--good" role="status">
            From now on this kiosk asks for the finger as well as the face.
          </p>
          {stage.passkey.synced && (
            <p className="small muted">
              This phone says it may copy the key to its own cloud account. The key holds no
              fingerprint — only the phone does — but note it for the records.
            </p>
          )}
          <div className="buttons">
            <button
              type="button"
              className="button"
              onClick={() => {
                setEmployeeId('');
                setAgreed(false);
                setRecordedConsentId(null);
                setStage({ name: 'choosing' });
              }}
            >
              Next worker
            </button>
            <button type="button" className="button button--quiet" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      )}

      {stage.name === 'failed' && (
        <>
          <OutcomeMark outcome="bad" />
          <p className="notice notice--bad" role="alert">
            {stage.message}
          </p>
          <div className="buttons">
            {recordedConsentId !== null && (
              // The consent is already on record, so a failed capture retries
              // from the camera — never back through the wording and the card
              // digits, which made every stumble cost a whole enrollment.
              <button
                type="button"
                className="button button--in"
                onClick={() => void captureThreeFaces(recordedConsentId)}
              >
                Try the face again
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={() => {
                setRecordedConsentId(null);
                setStage({ name: 'choosing' });
              }}
            >
              Start again
            </button>
            <button type="button" className="button button--quiet" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
