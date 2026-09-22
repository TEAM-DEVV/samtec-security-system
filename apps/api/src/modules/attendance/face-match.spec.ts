import { describe, expect, it } from 'vitest';
import {
  type FaceSample,
  findDuplicateFace,
  framesAgree,
  identifyFace,
  type KnownFace,
  sampleProblem,
  similarity,
} from './face-match.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

/**
 * A second, deliberately plain version of Human's formula, written straight
 * from docs/plan/13 section 3. The real one is written for speed; if the two
 * ever disagree, one of them has drifted from the formula the kiosk and the
 * server must share.
 */
function humanSimilarity(a: number[], b: number[]): number {
  const sumOfSquares = a
    .map((value, index) => (value - (b[index] as number)) ** 2)
    .reduce((total, value) => total + value, 0);
  const distance = 25 * sumOfSquares;
  return Math.max(0, Math.min(1, (1 - Math.sqrt(distance) / 100 - 0.2) / 0.6));
}

/**
 * A face is 1,024 numbers. These test faces are flat lists (every number the
 * same), so the score follows one simple line: with 1,024 numbers a step of
 * `d` between two faces scores `4/3 − (8/3) × d`. That makes 1 at a step of
 * 0.125, 0.6 (the clock-in threshold) at 0.275, 0.5 (the duplicate threshold)
 * at 0.3125, and 0 at 0.5 and beyond.
 */
function faceAt(level: number): number[] {
  return Array.from({ length: FACE_THRESHOLDS.embeddingLength }, () => level);
}

/** The score two flat faces this far apart will get, worked out by hand. */
function scoreForStep(step: number): number {
  return Math.max(0, Math.min(1, 4 / 3 - (8 / 3) * step));
}

/**
 * A face whose numbers are all different from each other, so that comparing
 * the wrong pairs of numbers would give a different answer. Flat faces cannot
 * catch that mistake, because every number in them is the same.
 */
function unevenFace(seed: number): number[] {
  return Array.from(
    { length: FACE_THRESHOLDS.embeddingLength },
    (_, index) => Math.sin(seed + index * 0.7) / 2,
  );
}

const sampleOf = (face: number[], extra: Partial<FaceSample> = {}): FaceSample => ({
  model: FACE_THRESHOLDS.model,
  embedding: face,
  real: 0.9,
  live: 0.9,
  ...extra,
});

describe('similarity', () => {
  it('gives 1 for the same face and 0 for two faces far apart', () => {
    const face = faceAt(0);

    expect(similarity(face, face)).toBe(1);
    expect(similarity(face, faceAt(1))).toBe(0);
  });

  it('matches the formula the kiosk uses, at every distance in between', () => {
    for (const step of [0, 0.1, 0.125, 0.2, 0.275, 0.3125, 0.4, 0.49, 0.5, 0.8]) {
      const score = similarity(faceAt(0), faceAt(step));

      expect(score).toBeCloseTo(humanSimilarity(faceAt(0), faceAt(step)), 12);
      expect(score).toBeCloseTo(scoreForStep(step), 12);
    }
  });

  it('compares number with matching number, on faces that are not flat', () => {
    const first = unevenFace(0);
    const second = unevenFace(0.35);

    expect(similarity(first, second)).toBeCloseTo(humanSimilarity(first, second), 12);
    expect(similarity(first, first)).toBe(1);
    // Comparing the same face against itself backwards is a different face:
    // this is what a mix-up in the pairing would look like.
    expect(similarity(first, [...first].reverse())).toBeLessThan(1);
  });

  it('works out the formula by hand, as a check on both versions', () => {
    // Two numbers, 3 apart each: Σ(a−b)² = 18, distance = 25 × 18 = 450,
    // similarity = (1 − √450 ÷ 100 − 0.2) ÷ 0.6.
    const expected = (1 - Math.sqrt(450) / 100 - 0.2) / 0.6;

    expect(expected).toBeCloseTo(0.9798, 4);
    expect(similarity([0, 0], [3, 3])).toBeCloseTo(expected, 12);
    // Closer than that is simply "the same face": the formula stops at 1.
    expect(similarity([0, 0], [0.1, 0.1])).toBe(1);
  });

  it('never answers on lists of different lengths, or on nothing', () => {
    expect(similarity([1, 2, 3], [1, 2])).toBe(0);
    // The short list first is the dangerous way round: comparing only as far
    // as it goes would call two different faces the same face.
    expect(similarity([1, 2], [1, 2, 3])).toBe(0);
    expect(similarity([], [])).toBe(0);
  });
});

describe('sampleProblem', () => {
  const face = faceAt(0.01);

  it('accepts a sound sample', () => {
    expect(sampleProblem(sampleOf(face))).toBeNull();
  });

  it('refuses another model, the wrong number of numbers, and numbers that are not numbers', () => {
    expect(sampleProblem(sampleOf(face, { model: 'other-model-1' }))).toBe('WRONG_MODEL');
    expect(sampleProblem(sampleOf([0.1, 0.2]))).toBe('WRONG_SHAPE');
    const broken = faceAt(0.01);
    broken[3] = Number.NaN;
    expect(sampleProblem(sampleOf(broken))).toBe('WRONG_SHAPE');
  });

  it('refuses a face that did not look real or alive enough', () => {
    expect(sampleProblem(sampleOf(face, { real: 0.59 }))).toBe('LOW_LIVENESS');
    expect(sampleProblem(sampleOf(face, { live: 0.59 }))).toBe('LOW_LIVENESS');
    // Exactly at the threshold is enough.
    expect(sampleProblem(sampleOf(face, { real: 0.6, live: 0.6 }))).toBeNull();
  });
});

describe('identifyFace', () => {
  const faces: KnownFace[] = [
    { credentialId: 'face-kwame', employeeId: 'kwame', embedding: faceAt(0) },
    { credentialId: 'face-ama', employeeId: 'ama', embedding: faceAt(0.6) },
  ];

  it('names the person when the face is close enough and clearly ahead', () => {
    // 0.2 from Kwame's face (0.8), 0.4 from Ama's (0.27): a clear lead.
    const result = identifyFace(sampleOf(faceAt(0.2)), faces);

    expect(result.outcome).toBe('MATCHED');
    expect(result.outcome === 'MATCHED' && result.employeeId).toBe('kwame');
    expect(result.scores.best).toBeCloseTo(0.8, 12);
    expect(result.scores.best - result.scores.runnerUp).toBeGreaterThanOrEqual(
      FACE_THRESHOLDS.lead,
    );
  });

  it('says "not sure" when two people are too close together', () => {
    const twin: KnownFace = {
      credentialId: 'face-twin',
      employeeId: 'twin',
      embedding: faceAt(0.01),
    };

    // 0.827 for the twin against 0.8 for Kwame: both good scores, no lead.
    const result = identifyFace(sampleOf(faceAt(0.2)), [...faces, twin]);

    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.scores.best - result.scores.runnerUp).toBeLessThan(FACE_THRESHOLDS.lead);
  });

  it('does not recognise a stranger, or anyone in an empty company', () => {
    expect(identifyFace(sampleOf(faceAt(1.2)), faces).outcome).toBe('NOT_RECOGNISED');
    expect(identifyFace(sampleOf(faceAt(0)), []).outcome).toBe('NOT_RECOGNISED');
  });

  it('refuses the sample before comparing anyone, and says why, with no scores', () => {
    const poorFace = identifyFace(sampleOf(faceAt(0), { live: 0.1 }), faces);
    const wrongModel = identifyFace(sampleOf(faceAt(0), { model: 'another-model' }), faces);

    expect(poorFace.outcome).toBe('REFUSED');
    expect(poorFace.outcome === 'REFUSED' && poorFace.problem).toBe('LOW_LIVENESS');
    expect(poorFace.scores).toEqual({ best: 0, runnerUp: 0 });
    // A kiosk sending the wrong kind of numbers is a different problem from a
    // worker whose face did not look alive: the answer keeps them apart.
    expect(wrongModel.outcome === 'REFUSED' && wrongModel.problem).toBe('WRONG_MODEL');
  });

  it("counts only other people as the runner-up, never a second face of the person's own record", () => {
    const olderFace: KnownFace = {
      credentialId: 'face-kwame-old',
      employeeId: 'kwame',
      embedding: faceAt(0.01),
    };

    const result = identifyFace(sampleOf(faceAt(0.2)), [...faces, olderFace]);

    expect(result.outcome).toBe('MATCHED');
    expect(result.outcome === 'MATCHED' && result.employeeId).toBe('kwame');
    // The closer of Kwame's two faces is the one named, so the attempt row
    // points at the face that actually matched.
    expect(result.outcome === 'MATCHED' && result.credentialId).toBe('face-kwame-old');
    // Ama, not Kwame's older face, is the runner-up.
    expect(result.scores.runnerUp).toBeCloseTo(scoreForStep(0.4), 12);
  });
});

describe('findDuplicateFace', () => {
  const faces: KnownFace[] = [
    { credentialId: 'face-guard', employeeId: 'guard', embedding: faceAt(0) },
    { credentialId: 'face-other', employeeId: 'other', embedding: faceAt(0.6) },
  ];

  it('reports the closest record when the new face is close enough to review', () => {
    const found = findDuplicateFace(sampleOf(faceAt(0.2)), faces, 'newcomer');

    expect(found?.employeeId).toBe('guard');
    expect(found?.credentialId).toBe('face-guard');
    expect(found?.score).toBeGreaterThanOrEqual(FACE_THRESHOLDS.duplicate);
    // The answer carries ids and a score, never a template.
    expect(Object.keys(found ?? {}).sort()).toEqual(['credentialId', 'employeeId', 'score']);
  });

  it('reports nobody for a new face, and never for a sample that cannot be used', () => {
    expect(findDuplicateFace(sampleOf(faceAt(1.2)), faces, 'newcomer')).toBeNull();
    expect(findDuplicateFace(sampleOf(faceAt(0)), [], 'newcomer')).toBeNull();
    expect(findDuplicateFace(sampleOf(faceAt(0), { real: 0.2 }), faces, 'newcomer')).toBeNull();
  });

  it('never makes a worker their own duplicate, even enrolling the same face again', () => {
    // The guard's own record is left out; nobody else is close.
    expect(findDuplicateFace(sampleOf(faceAt(0)), faces, 'guard')).toBeNull();
    // Someone else enrolling that same face is still caught.
    expect(findDuplicateFace(sampleOf(faceAt(0)), faces, 'ghost')?.employeeId).toBe('guard');
  });

  it('asks about a face it would not let clock in, because the check is looser', () => {
    // 0.29 away scores 0.56: too far to clock in, close enough to ask an ADMIN.
    const middling = sampleOf(faceAt(0.29));
    const found = findDuplicateFace(middling, faces, 'newcomer');

    expect(found?.score).toBeGreaterThanOrEqual(FACE_THRESHOLDS.duplicate);
    expect(found?.score).toBeLessThan(FACE_THRESHOLDS.match);
    expect(identifyFace(middling, faces).outcome).toBe('NOT_RECOGNISED');
  });

  it('draws both lines where the thresholds say', () => {
    // These samples sit on the far side of the guard's face, so the other
    // worker is nowhere near and only the threshold decides. A step of 0.3125
    // scores exactly 0.5 (the duplicate threshold), and a score on the line
    // counts. A step of 0.275 works out to 0.6 (the clock-in threshold) minus
    // five millionths of a millionth, because adding up 1,024 numbers leaves
    // a rounding error that small, so the samples either side of that line
    // are a hair away from it. No camera can tell faces apart that finely,
    // and either answer on the line itself is a safe one.
    expect(findDuplicateFace(sampleOf(faceAt(-0.3125)), faces, 'newcomer')?.employeeId).toBe(
      'guard',
    );
    expect(findDuplicateFace(sampleOf(faceAt(-0.312)), faces, 'newcomer')?.employeeId).toBe(
      'guard',
    );
    expect(findDuplicateFace(sampleOf(faceAt(-0.313)), faces, 'newcomer')).toBeNull();
    expect(identifyFace(sampleOf(faceAt(-0.2749)), faces).outcome).toBe('MATCHED');
    expect(identifyFace(sampleOf(faceAt(-0.2751)), faces).outcome).toBe('NOT_RECOGNISED');
  });
});

describe('framesAgree', () => {
  it('accepts three frames of one person', () => {
    expect(framesAgree([faceAt(0), faceAt(0.05), faceAt(0.1)])).toBe(true);
  });

  it('draws the line where the frames threshold says', () => {
    // A step of 0.23 scores 0.72, a step of 0.24 scores 0.69: a hair either
    // side of the 0.70 the design asks for.
    expect(framesAgree([faceAt(0), faceAt(0.23)])).toBe(true);
    expect(framesAgree([faceAt(0), faceAt(0.24)])).toBe(false);
  });

  it('refuses a capture that drifted from one face to another', () => {
    // Each frame agrees with the next one (0.80), but the first and the last
    // do not (0.27). Comparing only neighbours would let this through.
    expect(framesAgree([faceAt(0), faceAt(0.2), faceAt(0.4)])).toBe(false);
  });

  it('refuses frames that are not faces at all', () => {
    expect(framesAgree([faceAt(0), faceAt(0).slice(0, 512)])).toBe(false);
  });

  it('refuses a capture where the face changed part way through', () => {
    expect(framesAgree([faceAt(0), faceAt(0.05), faceAt(0.6)])).toBe(false);
  });

  it('refuses a capture with nothing to compare', () => {
    expect(framesAgree([faceAt(0)])).toBe(false);
    expect(framesAgree([])).toBe(false);
  });
});
