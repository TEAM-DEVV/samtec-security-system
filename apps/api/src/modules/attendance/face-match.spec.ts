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
 * A second, deliberately plain version of the cosine, written straight from
 * its definition. The real one is written for speed; if the two ever
 * disagree, one of them has drifted.
 */
function plainCosine(a: number[], b: number[]): number {
  const dot = a.reduce((total, value, i) => total + value * (b[i] as number), 0);
  const length = (v: number[]) => Math.sqrt(v.reduce((total, value) => total + value * value, 0));
  return Math.max(0, Math.min(1, dot / (length(a) * length(b))));
}

/**
 * Directions at exact right angles to each other, 1,024 numbers each, built
 * from uneven numbers (Gram–Schmidt) so that pairing the wrong numbers would
 * show. Any face can then be made at an exact similarity to any of them:
 * `x·A + y·B + √(1 − x² − y²)·C` scores exactly x against A and y against B.
 */
function directions(count: number): number[][] {
  const length = FACE_THRESHOLDS.embeddingLength;
  const made: number[][] = [];
  for (let k = 0; k < count; k += 1) {
    let v = Array.from(
      { length },
      (_, i) => Math.sin(1.7 * k + i * 0.731) + Math.cos(i * 0.113 * (k + 1)),
    );
    for (const previous of made) {
      const along = v.reduce((total, value, i) => total + value * (previous[i] as number), 0);
      v = v.map((value, i) => value - along * (previous[i] as number));
    }
    const size = Math.sqrt(v.reduce((total, value) => total + value * value, 0));
    made.push(v.map((value) => value / size));
  }
  return made;
}

const [A, B, C, D] = directions(4) as [number[], number[], number[], number[]];

/** A face scoring exactly `x` against A, `y` against B (and the rest along C). */
function faceAgainst(x: number, y = 0): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return A.map((a, i) => x * a + y * (B[i] as number) + rest * (C[i] as number));
}

const sampleOf = (face: number[], extra: Partial<FaceSample> = {}): FaceSample => ({
  model: FACE_THRESHOLDS.model,
  embedding: face,
  real: 0.9,
  live: 0.9,
  ...extra,
});

describe('similarity', () => {
  it('gives 1 for the same face and 0 for faces at right angles', () => {
    expect(similarity(A, A)).toBeCloseTo(1, 12);
    expect(similarity(A, B)).toBeCloseTo(0, 12);
  });

  it('is the cosine, at every angle in between', () => {
    for (const x of [0.05, 0.3, 0.5, 0.7, 0.75, 0.8, 0.9, 0.99]) {
      const face = faceAgainst(x);
      expect(similarity(A, face)).toBeCloseTo(x, 12);
      expect(similarity(A, face)).toBeCloseTo(plainCosine(A, face), 12);
    }
  });

  it('ignores how big the numbers are, which is the whole point', () => {
    // Light, distance and framing scale a face's numbers up and down
    // together. The old distance formula read that as a different face; the
    // angle does not move.
    const brighter = A.map((value) => value * 3.7);
    const dimmer = A.map((value) => value * 0.2);
    expect(similarity(A, brighter)).toBeCloseTo(1, 12);
    expect(similarity(dimmer, brighter)).toBeCloseTo(1, 12);
  });

  it('compares number with matching number', () => {
    // The same face backwards is a different face: this is what a mix-up in
    // the pairing would look like.
    expect(similarity(A, [...A].reverse())).toBeLessThan(0.5);
  });

  it('works out the cosine by hand, as a check on both versions', () => {
    // [3, 4] and [4, 3]: dot 24, lengths 5 and 5, cosine 24 / 25.
    expect(similarity([3, 4], [4, 3])).toBeCloseTo(0.96, 12);
    // Opposite directions are reported as nothing alike, never below it.
    expect(similarity([1, 0], [-1, 0])).toBe(0);
  });

  it('never answers on lists of different lengths, on nothing, or on no direction', () => {
    expect(similarity([1, 2, 3], [1, 2])).toBe(0);
    // The short list first is the dangerous way round: comparing only as far
    // as it goes would call two different faces the same face.
    expect(similarity([1, 2], [1, 2, 3])).toBe(0);
    expect(similarity([], [])).toBe(0);
    // A list of zeros points nowhere, so it is like nobody — not like everybody.
    expect(similarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe('sampleProblem', () => {
  const face = faceAgainst(0.9);

  it('accepts a sound sample', () => {
    expect(sampleProblem(sampleOf(face))).toBeNull();
  });

  it('refuses another model, the wrong number of numbers, and numbers that are not numbers', () => {
    expect(sampleProblem(sampleOf(face, { model: 'other-model-1' }))).toBe('WRONG_MODEL');
    expect(sampleProblem(sampleOf([0.1, 0.2]))).toBe('WRONG_SHAPE');
    const broken = [...face];
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
  // Kwame is direction A, Ama is direction B: two people at right angles.
  const faces: KnownFace[] = [
    { credentialId: 'face-kwame', employeeId: 'kwame', embedding: A },
    { credentialId: 'face-ama', employeeId: 'ama', embedding: B },
  ];

  it('names the person when the face is close enough and clearly ahead', () => {
    const result = identifyFace(sampleOf(faceAgainst(0.9, 0.2)), faces);

    expect(result.outcome).toBe('MATCHED');
    expect(result.outcome === 'MATCHED' && result.employeeId).toBe('kwame');
    expect(result.scores.best).toBeCloseTo(0.9, 12);
    expect(result.scores.runnerUp).toBeCloseTo(0.2, 12);
  });

  it('refuses the only enrolled worker to anyone who is not close enough', () => {
    // The real-phone failure: one worker on file, a stranger at the kiosk. No
    // runner-up exists, so the lead rule cannot help — the match line alone
    // must refuse. A stranger as alike as the most alike pair in the photo
    // test (0.79) is refused.
    const onlyKwame = faces.slice(0, 1);
    expect(identifyFace(sampleOf(faceAgainst(0.79)), onlyKwame).outcome).toBe('NOT_RECOGNISED');
    expect(identifyFace(sampleOf(faceAgainst(0.9)), onlyKwame).outcome).toBe('MATCHED');
  });

  it('says "not sure" when two people are too close together', () => {
    const twin: KnownFace = {
      credentialId: 'face-twin',
      employeeId: 'twin',
      embedding: faceAgainst(0.995),
    };
    const result = identifyFace(sampleOf(faceAgainst(0.9)), [...faces, twin]);

    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.scores.best - result.scores.runnerUp).toBeLessThan(FACE_THRESHOLDS.lead);
  });

  it('does not recognise a stranger, or anyone in an empty company', () => {
    expect(identifyFace(sampleOf(D), faces).outcome).toBe('NOT_RECOGNISED');
    expect(identifyFace(sampleOf(A), []).outcome).toBe('NOT_RECOGNISED');
  });

  it('refuses the sample before comparing anyone, and says why, with no scores', () => {
    const poorFace = identifyFace(sampleOf(A, { live: 0.1 }), faces);
    const wrongModel = identifyFace(sampleOf(A, { model: 'another-model' }), faces);

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
      embedding: faceAgainst(0.99),
    };

    const result = identifyFace(sampleOf(faceAgainst(0.98, 0.1)), [...faces, olderFace]);

    expect(result.outcome).toBe('MATCHED');
    expect(result.outcome === 'MATCHED' && result.employeeId).toBe('kwame');
    // Ama, not Kwame's other face, is the runner-up.
    expect(result.scores.runnerUp).toBeCloseTo(0.1, 12);
  });

  it('draws the clock-in line where the threshold says', () => {
    const line = FACE_THRESHOLDS.match;
    expect(identifyFace(sampleOf(faceAgainst(line + 0.001)), faces).outcome).toBe('MATCHED');
    expect(identifyFace(sampleOf(faceAgainst(line - 0.001)), faces).outcome).toBe('NOT_RECOGNISED');
  });
});

describe('findDuplicateFace', () => {
  const faces: KnownFace[] = [
    { credentialId: 'face-guard', employeeId: 'guard', embedding: A },
    { credentialId: 'face-other', employeeId: 'other', embedding: B },
  ];

  it('reports the closest record when the new face is close enough to review', () => {
    const found = findDuplicateFace(sampleOf(faceAgainst(0.9)), faces, 'newcomer');

    expect(found?.employeeId).toBe('guard');
    expect(found?.credentialId).toBe('face-guard');
    expect(found?.score).toBeCloseTo(0.9, 12);
    // The answer carries ids and a score, never a template.
    expect(Object.keys(found ?? {}).sort()).toEqual(['credentialId', 'employeeId', 'score']);
  });

  it('reports nobody for a new face, and never for a sample that cannot be used', () => {
    expect(findDuplicateFace(sampleOf(D), faces, 'newcomer')).toBeNull();
    expect(findDuplicateFace(sampleOf(A), [], 'newcomer')).toBeNull();
    expect(findDuplicateFace(sampleOf(A, { real: 0.2 }), faces, 'newcomer')).toBeNull();
  });

  it('never makes a worker their own duplicate, even enrolling the same face again', () => {
    // The guard's own record is left out; nobody else is close.
    expect(findDuplicateFace(sampleOf(A), faces, 'guard')).toBeNull();
    // Someone else enrolling that same face is still caught.
    expect(findDuplicateFace(sampleOf(A), faces, 'ghost')?.employeeId).toBe('guard');
  });

  it('asks about a face it would not let clock in, because the check is looser', () => {
    const middling = sampleOf(faceAgainst(0.75));
    const found = findDuplicateFace(middling, faces, 'newcomer');

    expect(found?.score).toBeGreaterThanOrEqual(FACE_THRESHOLDS.duplicate);
    expect(found?.score).toBeLessThan(FACE_THRESHOLDS.match);
    expect(identifyFace(middling, faces).outcome).toBe('NOT_RECOGNISED');
  });

  it('draws the duplicate line where the threshold says', () => {
    const line = FACE_THRESHOLDS.duplicate;
    expect(
      findDuplicateFace(sampleOf(faceAgainst(line + 0.001)), faces, 'newcomer')?.employeeId,
    ).toBe('guard');
    expect(findDuplicateFace(sampleOf(faceAgainst(line - 0.001)), faces, 'newcomer')).toBeNull();
  });
});

describe('framesAgree', () => {
  it('accepts three frames of one person', () => {
    expect(framesAgree([A, faceAgainst(0.97), faceAgainst(0.95)])).toBe(true);
  });

  it('draws the line where the frames threshold says', () => {
    const line = FACE_THRESHOLDS.frameAgreement;
    expect(framesAgree([A, faceAgainst(line + 0.001)])).toBe(true);
    expect(framesAgree([A, faceAgainst(line - 0.001)])).toBe(false);
  });

  it('refuses a capture that drifted from one face to another', () => {
    // Each frame is close to the next (0.9), but the first and the last are
    // not (0.62): every pair is checked, not only neighbours.
    const middle = faceAgainst(0.9);
    const last = faceAgainst(0.62);
    expect(similarity(A, middle)).toBeGreaterThan(FACE_THRESHOLDS.frameAgreement);
    expect(similarity(middle, last)).toBeGreaterThan(FACE_THRESHOLDS.frameAgreement);
    expect(framesAgree([A, middle, last])).toBe(false);
  });

  it('refuses frames that are not faces at all', () => {
    expect(framesAgree([A, A.slice(0, 512)])).toBe(false);
  });

  it('refuses a capture where the face changed part way through', () => {
    expect(framesAgree([A, faceAgainst(0.97), B])).toBe(false);
  });

  it('refuses a capture with nothing to compare', () => {
    expect(framesAgree([A])).toBe(false);
    expect(framesAgree([])).toBe(false);
  });
});
