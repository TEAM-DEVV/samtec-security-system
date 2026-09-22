/**
 * Comparing faces, as pure rules (docs/plan/13-biometrics-design.md section 3).
 * A face is never a photo here: it is a list of 1,024 numbers that the kiosk's
 * model (Human) made from the camera picture.
 *
 * The score is Human's own formula, copied to the server so the kiosk and the
 * server always agree on what "alike" means:
 *
 *   distance   = 25 × Σ(aᵢ − bᵢ)²
 *   similarity = clamp((1 − √distance ÷ 100 − 0.2) ÷ 0.6, 0, 1)
 *
 * It measures plain distance between the two lists (Euclidean), not the angle
 * between them (cosine). 1 means the same numbers; 0 means nothing alike.
 *
 * Nothing in this file reads the database, decrypts anything or logs anything.
 */
import { FACE_THRESHOLDS } from './face-thresholds.js';

/** What the kiosk sends: the numbers, plus its own anti-spoofing scores. */
export interface FaceSample {
  model: string;
  embedding: number[];
  /** How real the face looked (not a printed photo), 0 to 1. */
  real: number;
  /** How alive it looked (not a still picture on a screen), 0 to 1. */
  live: number;
}

/** One stored face to compare against, with the ids the answer needs. */
export interface KnownFace {
  credentialId: string;
  employeeId: string;
  embedding: number[];
}

/** Why a sample cannot be used at all. Null means it may be compared. */
export type SampleProblem = 'WRONG_MODEL' | 'WRONG_SHAPE' | 'LOW_LIVENESS';

/**
 * What 1:N identification decided. The scores stay on the server: the kiosk is
 * told who it is, never how close anyone was (docs/plan/13 section 3).
 */
export type Identification =
  | { outcome: 'MATCHED'; credentialId: string; employeeId: string; scores: Scores }
  | { outcome: 'AMBIGUOUS' | 'NOT_RECOGNISED'; scores: Scores }
  /** The sample was never compared with anyone, and the problem says why. */
  | { outcome: 'REFUSED'; problem: SampleProblem; scores: Scores };

/** The best score, and the best score of any *other* person. */
export interface Scores {
  best: number;
  runnerUp: number;
}

const NO_SCORES: Scores = { best: 0, runnerUp: 0 };

/** Human's similarity, 0 to 1. Both lists must be the same length. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    // Both lists are the same length, so every index is really there.
    const difference = (a[i] as number) - (b[i] as number);
    sum += difference * difference;
  }
  const distance = 25 * sum;
  if (!Number.isFinite(distance)) {
    return 0;
  }
  const scaled = (1 - Math.sqrt(distance) / 100 - 0.2) / 0.6;
  return Math.min(1, Math.max(0, scaled));
}

/** Checks a sample before it is compared with anyone: the model, the shape, the anti-spoofing scores. */
export function sampleProblem(sample: FaceSample): SampleProblem | null {
  if (sample.model !== FACE_THRESHOLDS.model) {
    return 'WRONG_MODEL';
  }
  if (
    sample.embedding.length !== FACE_THRESHOLDS.embeddingLength ||
    !sample.embedding.every((value) => Number.isFinite(value))
  ) {
    return 'WRONG_SHAPE';
  }
  if (
    !(sample.real >= FACE_THRESHOLDS.antiSpoofing) ||
    !(sample.live >= FACE_THRESHOLDS.antiSpoofing)
  ) {
    return 'LOW_LIVENESS';
  }
  return null;
}

/**
 * Clock-in: who is this? A match needs a good enough score **and** a clear
 * lead over the next person, so two people who look alike can never be told
 * apart by a hair's breadth.
 */
export function identifyFace(sample: FaceSample, faces: readonly KnownFace[]): Identification {
  const problem = sampleProblem(sample);
  if (problem !== null) {
    return { outcome: 'REFUSED', problem, scores: NO_SCORES };
  }
  const best = bestFace(sample.embedding, faces);
  if (!best) {
    return { outcome: 'NOT_RECOGNISED', scores: NO_SCORES };
  }
  // The runner-up is the best score of a *different* person: two faces of one
  // person (an old one kept for evidence) must never look like a close call.
  const runnerUp = faces.reduce((highest, face) => {
    if (face.employeeId === best.employeeId) {
      return highest;
    }
    return Math.max(highest, similarity(sample.embedding, face.embedding));
  }, 0);
  const scores: Scores = { best: best.score, runnerUp };

  if (best.score < FACE_THRESHOLDS.match) {
    return { outcome: 'NOT_RECOGNISED', scores };
  }
  if (best.score - runnerUp < FACE_THRESHOLDS.lead) {
    return { outcome: 'AMBIGUOUS', scores };
  }
  return {
    outcome: 'MATCHED',
    credentialId: best.credentialId,
    employeeId: best.employeeId,
    scores,
  };
}

/** Who a new face looked like, and how closely. Never the numbers themselves. */
export interface DuplicateFace {
  credentialId: string;
  employeeId: string;
  score: number;
}

/**
 * Enrollment: does this face already belong to **someone else**? Only the
 * closest record is reported, and only if it is close enough to ask a second
 * ADMIN about (docs/plan/13 section 2).
 */
export function findDuplicateFace(
  sample: FaceSample,
  faces: readonly KnownFace[],
  enrollingEmployeeId: string,
): DuplicateFace | null {
  if (sampleProblem(sample) !== null) {
    return null;
  }
  // Nobody is their own duplicate: the worker's own older faces are left out
  // here, rather than leaving that to every caller (docs/plan/13 section 2).
  const others = faces.filter((face) => face.employeeId !== enrollingEmployeeId);
  const best = bestFace(sample.embedding, others);
  if (!best || best.score < FACE_THRESHOLDS.duplicate) {
    return null;
  }
  // Only the ids and the score leave this function, never the numbers.
  return { credentialId: best.credentialId, employeeId: best.employeeId, score: best.score };
}

/**
 * Enrollment: the frames of one capture must agree with each other, which
 * catches one person starting the capture and another finishing it.
 */
export function framesAgree(frames: readonly (readonly number[])[]): boolean {
  if (frames.length < 2) {
    return false;
  }
  for (let i = 0; i < frames.length; i += 1) {
    for (let j = i + 1; j < frames.length; j += 1) {
      const score = similarity(frames[i] as number[], frames[j] as number[]);
      if (score < FACE_THRESHOLDS.frameAgreement) {
        return false;
      }
    }
  }
  return true;
}

function bestFace(
  embedding: readonly number[],
  faces: readonly KnownFace[],
): (KnownFace & { score: number }) | null {
  let best: (KnownFace & { score: number }) | null = null;
  for (const face of faces) {
    const score = similarity(embedding, face.embedding);
    if (!best || score > best.score) {
      best = { ...face, score };
    }
  }
  return best;
}
