import type { FaceSample } from '@samtec/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_SECONDS,
  EMBEDDING_LENGTH,
  FACE_MODEL,
  type FaceReading,
  headTurnInstruction,
  MIN_ANTI_SPOOFING,
  MIN_FACE_PIXELS,
  randomHeadTurn,
  readingIsLive,
  readingIsUsable,
} from './face';

/**
 * The liveness rules.
 *
 * This is the kiosk's most safety-critical code and it had no test at all. The
 * server checks these numbers again, but it cannot see the camera — so a frame
 * this file waves through is a frame the system trusts on the kiosk's word.
 *
 * Every number here is the server's, from
 * `apps/api/src/modules/attendance/face-thresholds.ts`. A test that reads the
 * same constant it is checking proves nothing, so the numbers are written out.
 */
/** A sample with the scores a good frame has, unless a test says otherwise. */
function aSample(scores: { real?: number; live?: number } = {}): FaceSample {
  return {
    model: FACE_MODEL,
    embedding: Array.from({ length: EMBEDDING_LENGTH }, () => 0.5),
    real: scores.real ?? 0.9,
    live: scores.live ?? 0.9,
  };
}

function aReading(over: Partial<FaceReading> = {}): FaceReading {
  return {
    sample: aSample(),
    facePixels: 320,
    turnedTo: null,
    problem: null,
    ...over,
  };
}

describe('the numbers', () => {
  it('are the server’s numbers', () => {
    // If one of these changes, the same line has to change in
    // apps/api/src/modules/attendance/face-thresholds.ts, or the kiosk starts
    // sending frames the server will refuse.
    expect(MIN_ANTI_SPOOFING).toBe(0.6);
    expect(MIN_FACE_PIXELS).toBe(224);
    expect(EMBEDDING_LENGTH).toBe(512);
    expect(FACE_MODEL).toBe('arcface-mbf-1');
    expect(CHALLENGE_SECONDS).toBe(30);
  });
});

describe('a live frame', () => {
  it('accepts a good one', () => {
    expect(readingIsLive(aReading())).toBe(true);
  });

  it('refuses a frame with no face in it', () => {
    expect(readingIsLive(aReading({ sample: null }))).toBe(false);
  });

  it('refuses a face too far away to judge', () => {
    // A small face is a face the model cannot really see, and the server checks
    // the same thing, so sending it only wastes a round trip.
    expect(readingIsLive(aReading({ facePixels: 223 }))).toBe(false);
    expect(readingIsLive(aReading({ facePixels: 224 }))).toBe(true);
  });

  it('refuses a frame the anti-spoofing is unsure about, on either score', () => {
    expect(readingIsLive(aReading({ sample: aSample({ real: 0.59 }) }))).toBe(false);
    expect(readingIsLive(aReading({ sample: aSample({ live: 0.59 }) }))).toBe(false);
    // Exactly at the threshold counts, the same way the server counts it.
    expect(readingIsLive(aReading({ sample: aSample({ real: 0.6, live: 0.6 }) }))).toBe(true);
  });

  it('refuses a frame the engine itself complained about', () => {
    expect(readingIsLive(aReading({ problem: 'No face in view.' }))).toBe(false);
  });

  it('does not care which way the head is looking', () => {
    // On purpose: the turn frame has to pass this too, which is what stops one
    // person doing the head turn and a photograph supplying the face.
    expect(readingIsLive(aReading({ turnedTo: 'LEFT' }))).toBe(true);
  });
});

describe('a frame that can be sent', () => {
  it('has to be live and looking straight ahead', () => {
    expect(readingIsUsable(aReading())).toBe(true);
    expect(readingIsUsable(aReading({ turnedTo: 'RIGHT' }))).toBe(false);
  });

  it('is never a turned frame that would otherwise pass', () => {
    // The sample sent to the server is the centred one. A turned face is a
    // worse match against an enrolled front-facing template, so sending it
    // would fail for a reason that looks like "not recognised".
    expect(readingIsUsable(aReading({ turnedTo: 'LEFT' }))).toBe(false);
  });
});

describe('the head turn', () => {
  it('is one of two directions', () => {
    const drawn = new Set(Array.from({ length: 50 }, () => randomHeadTurn()));
    for (const turn of drawn) {
      expect(['LEFT', 'RIGHT']).toContain(turn);
    }
  });

  it('is not always the same one', () => {
    // A predictable side would let somebody hold up two printed photographs,
    // which is the whole reason this is drawn rather than fixed. Fifty draws
    // landing on one side has a probability around 1 in 10^15.
    const drawn = new Set(Array.from({ length: 50 }, () => randomHeadTurn()));
    expect(drawn.size).toBe(2);
  });

  it('asks in words a person can follow without thinking', () => {
    expect(headTurnInstruction('LEFT')).toBe('Turn your head to the left');
    expect(headTurnInstruction('RIGHT')).toBe('Turn your head to the right');
  });
});
