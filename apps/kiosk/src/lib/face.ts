import type { FaceSample } from '@samtec/contracts';

/**
 * Reading a face from the camera.
 *
 * Behind one interface, for the same reason the API puts its face matching
 * behind `BiometricProvider`: the engine is the one part of this system we did
 * not write and cannot fix. Human 3.3.6 is pinned and its last release is from
 * August 2025, so the day it stops working the replacement goes in here and
 * nothing above this line changes.
 *
 * Every number the engine has to reach is the server's, from
 * `apps/api/src/modules/attendance/face-thresholds.ts`. They are repeated here
 * because the kiosk checks them first — a sample the server would refuse should
 * never leave the phone, so the guard hears "try again" from the screen in front
 * of them rather than after a round trip. The server checks them all again: it
 * cannot see the camera, so it trusts nothing the kiosk says about liveness.
 *
 * Design: docs/plan/13-biometrics-design.md sections 3 and 7.
 */

/** The model that makes the numbers. Faces from two models are never compared. */
export const FACE_MODEL = 'human-faceres-1';
/** How many numbers one face template has. */
export const EMBEDDING_LENGTH = 1024;
/** `real` and `live` must both reach this, here and again on the server. */
export const MIN_ANTI_SPOOFING = 0.6;
/** A face smaller than this in the frame is too far away to judge. */
export const MIN_FACE_PIXELS = 224;
/** The head turn has to be finished inside this. */
export const CHALLENGE_SECONDS = 20;

/** Which way the kiosk asks the head to turn. Chosen at random, one at a time. */
export type HeadTurn = 'LEFT' | 'RIGHT';

/** What the camera saw in one frame. */
export interface FaceReading {
  /** The sample to send, or `null` when this frame is not usable. */
  sample: FaceSample | null;
  /** How wide the face is in the frame, in pixels. */
  facePixels: number;
  /** Which way the head is turned right now, or `null` when it is centred. */
  turnedTo: HeadTurn | null;
  /** Why this frame is not usable, in words a guard can act on. */
  problem: string | null;
}

/** A camera the kiosk can read faces from. */
export interface FaceEngine {
  /** Loads the models. Called once, before the camera is shown. */
  start: (video: HTMLVideoElement) => Promise<void>;
  /** Reads the current frame. Called many times a second while a challenge runs. */
  read: () => Promise<FaceReading>;
  /** Releases the camera and the models. */
  stop: () => void;
}

/** A reading that really has a sample, so callers do not have to re-check. */
export interface UsableReading extends FaceReading {
  sample: FaceSample;
}

/**
 * True when a reading is good enough to send.
 *
 * Written as a type guard so the caller gets a sample it does not have to
 * null-check again. Re-checking is where a "cannot be null here" comment gets
 * written and then stops being true.
 */
export function readingIsUsable(reading: FaceReading): reading is UsableReading {
  return (
    reading.sample !== null &&
    reading.problem === null &&
    reading.facePixels >= MIN_FACE_PIXELS &&
    reading.sample.real >= MIN_ANTI_SPOOFING &&
    reading.sample.live >= MIN_ANTI_SPOOFING
  );
}

/**
 * Picks a head turn nobody can guess in advance.
 *
 * The whole value of the challenge is that a photograph cannot answer it. A
 * predictable side would let somebody hold up two printed photographs, so this
 * uses the browser's cryptographic randomness rather than `Math.random`.
 */
export function randomHeadTurn(): HeadTurn {
  const draw = new Uint8Array(1);
  crypto.getRandomValues(draw);
  return (draw[0] ?? 0) % 2 === 0 ? 'LEFT' : 'RIGHT';
}

/** What the screen asks for, in words. */
export function headTurnInstruction(turn: HeadTurn): string {
  return turn === 'LEFT' ? 'Turn your head to the left' : 'Turn your head to the right';
}
