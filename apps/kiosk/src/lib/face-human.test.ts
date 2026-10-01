import { describe, expect, it } from 'vitest';
import { readingIsLive, readingIsUsable } from './face';
import { type DetectedFace, humanConfig, readingFrom } from './face-human';

/**
 * The pure half of the real engine: Human's answer for one frame, turned into
 * the reading the screens act on. Whether the real models accept a real face
 * is the phone check in docs/plan/13 section 7 — no test runner has a camera,
 * so what is pinned here is every rule *around* the models: the mapping, the
 * turn thresholds, the two-people refusal, and the sign convention living in
 * exactly one place.
 */

function aFace(overrides: Partial<DetectedFace> = {}): DetectedFace {
  return {
    embedding: new Array(1024).fill(0.25),
    real: 0.9,
    live: 0.9,
    box: [100, 80, 300, 300],
    rotation: { angle: { yaw: 0 } },
    ...overrides,
  };
}

describe('readingFrom', () => {
  it('turns a good centred frame into a usable reading', () => {
    const reading = readingFrom([aFace()]);
    expect(reading.problem).toBeNull();
    expect(reading.facePixels).toBe(300);
    expect(reading.sample?.model).toBe('human-faceres-1');
    expect(reading.sample?.embedding).toHaveLength(1024);
    expect(readingIsUsable(reading)).toBe(true);
  });

  it('says plainly when nobody is in view', () => {
    const reading = readingFrom([]);
    expect(reading.sample).toBeNull();
    expect(reading.problem).toContain('No face in view');
  });

  it('refuses two faces: matching either could punch for a passer-by', () => {
    const reading = readingFrom([aFace(), aFace({ box: [500, 80, 250, 250] })]);
    expect(reading.sample).toBeNull();
    expect(reading.problem).toBe('One person at a time, please.');
  });

  it('reads the head turn from the yaw, with a dead band in the middle', () => {
    // Turned far enough one way or the other.
    expect(readingFrom([aFace({ rotation: { angle: { yaw: 0.5 } } })]).turnedTo).toBe('RIGHT');
    expect(readingFrom([aFace({ rotation: { angle: { yaw: -0.5 } } })]).turnedTo).toBe('LEFT');
    // Centred: usable for a sample.
    expect(readingFrom([aFace({ rotation: { angle: { yaw: 0.1 } } })]).turnedTo).toBeNull();
    // The dead band between centred and turned: no turn, and no sample —
    // one wobble can never answer the challenge and supply the sample at once.
    const wobble = readingFrom([aFace({ rotation: { angle: { yaw: 0.28 } } })]);
    expect(wobble.turnedTo).toBeNull();
    expect(wobble.sample).toBeNull();
    expect(wobble.problem).toBeNull();
    expect(readingIsUsable(wobble)).toBe(false);
  });

  it('keeps the anti-spoofing scores exactly as the models gave them', () => {
    const reading = readingFrom([aFace({ real: 0.31, live: 0.72 })]);
    expect(reading.sample?.real).toBe(0.31);
    expect(reading.sample?.live).toBe(0.72);
    // Judging them is `readingIsLive`'s job, with the server's numbers.
    expect(readingIsLive(reading)).toBe(false);
  });

  it('refuses a frame whose measurement is missing or the wrong shape', () => {
    const shapeless = readingFrom([aFace({ embedding: new Array(128).fill(0.5) })]);
    expect(shapeless.sample).toBeNull();
    expect(shapeless.problem).toContain('could not be measured');
    const missing = readingFrom([aFace({ embedding: undefined as unknown as number[] })]);
    expect(missing.sample).toBeNull();
  });
});

describe('humanConfig', () => {
  const config = humanConfig('/models');

  it('measures every frame afresh, so a sample is never an older frame', () => {
    // A reused measurement sent the face of a turned head as the "look
    // straight" sample, and a stranger clocked in as somebody else.
    expect(config.cacheSensitivity).toBe(0);
    for (const model of [
      config.face.detector,
      config.face.description,
      config.face.antispoof,
      config.face.liveness,
    ]) {
      expect(model.skipFrames).toBe(0);
      expect(model.skipTime).toBe(0);
    }
  });

  it('loads the models from this app only, and feeds them the unfiltered image', () => {
    expect(config.modelBasePath).toBe('/models');
    expect(config.filter.enabled).toBe(false);
    expect(config.face.description.modelPath).toBe('faceres.json');
  });
});
