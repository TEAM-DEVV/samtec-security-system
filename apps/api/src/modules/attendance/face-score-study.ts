/**
 * The machinery behind the threshold report (docs/guides/14-face-threshold-report.md):
 * how far apart two faces score, and what each threshold would decide.
 *
 * Nothing in the running API uses this file. Only the report script
 * (`pnpm --filter @samtec/api face:scores`) and its own test do. It lives
 * beside `face-match.ts` because it is face knowledge, and because it must use
 * the *shipped* `similarity` — a report measured with a private copy of the
 * formula would prove nothing about what the kiosk actually does.
 *
 * Two things are measured, because they are the two decisions the numbers make:
 *
 * 1. **Clock-in** (1:N): is the best score high enough, and does it lead the
 *    runner-up clearly enough? Getting this wrong either lets the wrong person
 *    be paid or leaves an honest guard outside the gate.
 * 2. **Enrollment**: would a new face be stopped as a possible duplicate? Too
 *    loose and a ghost slips in under a second name; too tight and an
 *    administrator is asked about strangers all day.
 *
 * The study set is either real pilot captures or, until the pilot happens, a
 * stand-in generated to a chosen separation. The stand-in is not a measurement
 * of real faces and the report says so; what it does prove is that the
 * decision logic behaves as described as the numbers move.
 */

import { type KnownFace, similarity } from './face-match.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

/**
 * Human's formula, turned around: the per-number difference between two
 * templates that scores exactly `score`.
 *
 * The formula is `similarity = (1 − √(25·Σ(aᵢ−bᵢ)²)/100 − 0.2) / 0.6`, so
 * `√Σ(aᵢ−bᵢ)² = 16 − 12·score`, and spreading that evenly over the
 * template's numbers gives the difference each one carries. It is why a
 * 1,024-number template only ever scores between 0 and 1 for per-number
 * differences between 0.125 and 0.5 — a fact that has caught out more than one
 * test written with made-up vectors.
 */
export function offsetForScore(score: number, length = FACE_THRESHOLDS.embeddingLength): number {
  const totalOffset = 16 - 12 * Math.min(1, Math.max(0, score));
  return totalOffset / Math.sqrt(length);
}

/** One person in the study: the face they enrolled, and later captures of them. */
export interface StudyPerson {
  employeeId: string;
  credentialId: string;
  /** The template they enrolled with. */
  enrolled: number[];
  /** Captures taken afterwards, as a kiosk would take them. */
  captures: number[][];
  /** Three frames of one capture, which must agree with each other. */
  frames: number[][];
}

/**
 * How a stand-in study set is shaped.
 *
 * The three scores are **targets**, not promises. They are hit exactly when
 * `spread` is 0; above that they come out a little low, and the
 * different-person target comes out lowest of all. The reason is worth knowing,
 * because a reader of the report will ask: `spread` varies the *distance*
 * between templates, and a score is a square root of that distance, so an even
 * spread of distances gives a lop-sided spread of scores. The low tail is then
 * cut off at 0, which is the formula's floor, and the average of what is left
 * sits below the target. At `spread` 0.28 the different-person average lands
 * around 0.19 for a target of 0.30.
 *
 * So the report quotes **what a run measured**, never these targets, and the
 * test beside this file pins the gap at the spreads the report actually uses.
 */
export interface StudyShape {
  people: number;
  /** Captures per person, after the one they enrolled with. */
  capturesEach: number;
  /** Target mean score between two captures of the same person. */
  sameScore: number;
  /** Target mean score between captures of two different people. */
  differentScore: number;
  /** Target mean score between two frames of one capture (moments apart, so closer). */
  frameScore: number;
  /**
   * How widely capture quality and facial likeness vary, 0 to 1. This is what
   * makes the two score distributions overlap, which is the whole question the
   * report answers. 0 would give two perfect spikes and prove nothing.
   */
  spread: number;
  /**
   * How many pairs of people are deliberately placed close together, as real
   * look-alikes and siblings are.
   *
   * Without these the stand-in cannot produce a near-miss at all: spread evenly
   * over 1,024 numbers, a random stranger practically never beats your own
   * enrolled face, so the lead rule would never be exercised and a report
   * saying "nobody was ever matched to the wrong person" would be measuring
   * the generator, not the thresholds.
   */
  lookalikePairs: number;
  /** How closely a look-alike pair scores. Above `match` on purpose. */
  lookalikeScore: number;
  seed: number;
}

export const DEFAULT_SHAPE: StudyShape = {
  people: 40,
  capturesEach: 5,
  sameScore: 0.8,
  differentScore: 0.3,
  frameScore: 0.88,
  spread: 0.15,
  lookalikePairs: 2,
  lookalikeScore: 0.68,
  seed: 20260925,
};

/**
 * A repeatable random number generator (mulberry32), so the report prints the
 * same numbers every time it runs and a reader can check them.
 */
function randomNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One draw from a bell curve with mean 0 and width 1 (Box–Muller). */
function bellCurve(next: () => number): number {
  const first = Math.max(next(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * next());
}

/** A list of `length` numbers whose typical size is `rms`, with uneven values. */
function offsetVector(next: () => number, length: number, rms: number): number[] {
  const raw = Array.from({ length }, () => bellCurve(next));
  // Scale the list so its root-mean-square is exactly `rms`, whatever the draw
  // happened to be. Without this the target score drifts with the seed.
  const size = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0) / length);
  const factor = size === 0 ? 0 : rms / size;
  return raw.map((value) => value * factor);
}

/**
 * A factor around 1, for varying capture quality and facial likeness. It never
 * drops below half, because a person at a quarter of the normal distance from
 * everybody else is not a look-alike, it is a twin — and a stand-in that
 * invents twins makes the thresholds look worse than any real crowd would.
 */
function variation(next: () => number, spread: number): number {
  return Math.max(0.5, 1 + bellCurve(next) * spread);
}

/**
 * Builds a stand-in study set. People are placed apart from each other and
 * their captures jittered around them, so the scores that come out are
 * consistent: if two captures of one person are close, every other comparison
 * of those two is close too. That is what makes 1:N identification on this set
 * mean anything.
 */
export function makeStudySet(shape: StudyShape = DEFAULT_SHAPE): StudyPerson[] {
  if (!(shape.differentScore < shape.sameScore)) {
    throw new Error('differentScore must be below sameScore, or there is nothing to separate.');
  }
  const length = FACE_THRESHOLDS.embeddingLength;
  const next = randomNumbers(shape.seed);

  // Two captures of one person differ by the jitter of each, so one capture's
  // jitter is the same-person offset divided by √2.
  const captureJitter = offsetForScore(shape.sameScore, length) / Math.SQRT2;
  const frameJitter = offsetForScore(shape.frameScore, length) / Math.SQRT2;
  // Two people's captures differ by how far apart the people are *plus* both
  // jitters, so the distance between people is what is left over.
  const betweenPeople = Math.sqrt(
    Math.max(0, offsetForScore(shape.differentScore, length) ** 2 - 2 * captureJitter ** 2),
  );

  const crowd = offsetVector(next, length, 1);
  // Everybody's own face first: half the gap each, so two people are
  // `betweenPeople` apart on average. The factor is per person, so some people
  // really do look more alike than others.
  const faces = Array.from({ length: shape.people }, () =>
    offsetVector(next, length, (betweenPeople / Math.SQRT2) * variation(next, shape.spread)).map(
      (value, i) => value + (crowd[i] as number),
    ),
  );

  // Then the look-alikes: the second of each pair is moved next to the first.
  const pairs = Math.min(
    Math.max(0, Math.trunc(shape.lookalikePairs)),
    Math.floor(shape.people / 2),
  );
  const lookalikeGap = Math.sqrt(
    Math.max(0, offsetForScore(shape.lookalikeScore, length) ** 2 - 2 * captureJitter ** 2),
  );
  for (let pair = 0; pair < pairs; pair += 1) {
    const first = faces[pair * 2] as number[];
    const offset = offsetVector(next, length, lookalikeGap);
    faces[pair * 2 + 1] = first.map((value, i) => value + (offset[i] as number));
  }

  return faces.map((face, index) => {
    const capture = (jitter: number): number[] => {
      const offset = offsetVector(next, length, jitter * variation(next, shape.spread));
      return face.map((value, i) => value + (offset[i] as number));
    };
    return {
      employeeId: `employee-${index + 1}`,
      credentialId: `credential-${index + 1}`,
      enrolled: capture(captureJitter),
      captures: Array.from({ length: shape.capturesEach }, () => capture(captureJitter)),
      frames: Array.from({ length: 3 }, () => capture(frameJitter)),
    };
  });
}

/** The people who were placed next to each other, as `[first, second]` ids. */
export function lookalikePairsIn(shape: StudyShape): [string, string][] {
  const pairs = Math.min(
    Math.max(0, Math.trunc(shape.lookalikePairs)),
    Math.floor(shape.people / 2),
  );
  return Array.from({ length: pairs }, (_unused, pair) => [
    `employee-${pair * 2 + 1}`,
    `employee-${pair * 2 + 2}`,
  ]);
}

/** Every score in the study, split by whether the two faces are the same person. */
export interface ScoreSpread {
  /** A capture against the same person's enrolled face. */
  samePerson: number[];
  /** A capture against somebody else's enrolled face. */
  differentPerson: number[];
  /** Two frames of one capture, against each other. */
  frames: number[];
}

export function collectScores(people: readonly StudyPerson[]): ScoreSpread {
  const samePerson: number[] = [];
  const differentPerson: number[] = [];
  const frames: number[] = [];
  for (const person of people) {
    for (const capture of person.captures) {
      for (const other of people) {
        const score = similarity(capture, other.enrolled);
        if (other.employeeId === person.employeeId) {
          samePerson.push(score);
        } else {
          differentPerson.push(score);
        }
      }
    }
    for (let i = 0; i < person.frames.length; i += 1) {
      for (let j = i + 1; j < person.frames.length; j += 1) {
        frames.push(similarity(person.frames[i] as number[], person.frames[j] as number[]));
      }
    }
  }
  return { samePerson, differentPerson, frames };
}

/** The shape of one set of scores, in the few figures a report needs. */
export interface Summary {
  count: number;
  lowest: number;
  fifth: number;
  middle: number;
  ninetyFifth: number;
  highest: number;
  mean: number;
}

export function summarise(scores: readonly number[]): Summary {
  if (scores.length === 0) {
    return { count: 0, lowest: 0, fifth: 0, middle: 0, ninetyFifth: 0, highest: 0, mean: 0 };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] as number;
  return {
    count: sorted.length,
    lowest: sorted[0] as number,
    fifth: at(0.05),
    middle: at(0.5),
    ninetyFifth: at(0.95),
    highest: sorted[sorted.length - 1] as number,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

/** The best score against this person, and the best against anybody else. */
export interface Attempt {
  /** The person the capture really belongs to. */
  employeeId: string;
  best: number;
  bestEmployeeId: string;
  runnerUp: number;
}

/**
 * Every clock-in attempt in the study, scored 1:N against the enrolled faces —
 * the same comparison `identifyFace` makes, kept as raw scores so the same
 * attempts can be judged again at other thresholds.
 */
export function scoreAttempts(people: readonly StudyPerson[]): Attempt[] {
  const attempts: Attempt[] = [];
  for (const person of people) {
    for (const capture of person.captures) {
      let best = 0;
      let bestEmployeeId = '';
      for (const other of people) {
        const score = similarity(capture, other.enrolled);
        if (score > best) {
          best = score;
          bestEmployeeId = other.employeeId;
        }
      }
      const runnerUp = people.reduce((highest, other) => {
        if (other.employeeId === bestEmployeeId) {
          return highest;
        }
        return Math.max(highest, similarity(capture, other.enrolled));
      }, 0);
      attempts.push({ employeeId: person.employeeId, best, bestEmployeeId, runnerUp });
    }
  }
  return attempts;
}

/** What one clock-in attempt came to. The names are the contract's outcomes. */
export type AttemptVerdict = 'MATCHED' | 'WRONG_PERSON' | 'AMBIGUOUS' | 'NOT_RECOGNISED';

/**
 * The clock-in rule, on its own: high enough, and clearly ahead. It is a
 * separate function only so the report can ask "and what if this number
 * moved?"; its test proves it agrees with `identifyFace` at the shipped
 * numbers, so the report and the kiosk can never drift apart.
 */
export function verdictFor(attempt: Attempt, match: number, lead: number): AttemptVerdict {
  if (attempt.best < match) {
    return 'NOT_RECOGNISED';
  }
  if (attempt.best - attempt.runnerUp < lead) {
    return 'AMBIGUOUS';
  }
  return attempt.bestEmployeeId === attempt.employeeId ? 'MATCHED' : 'WRONG_PERSON';
}

export type VerdictCounts = Record<AttemptVerdict, number>;

export function countVerdicts(
  attempts: readonly Attempt[],
  match: number,
  lead: number,
): VerdictCounts {
  const counts: VerdictCounts = {
    MATCHED: 0,
    WRONG_PERSON: 0,
    AMBIGUOUS: 0,
    NOT_RECOGNISED: 0,
  };
  for (const attempt of attempts) {
    counts[verdictFor(attempt, match, lead)] += 1;
  }
  return counts;
}

/** What the duplicate check would do at one threshold. */
export interface DuplicateCounts {
  /** Honest new starters who were wrongly held for a second administrator. */
  strangersStopped: number;
  strangers: number;
  /** Second enrollments of somebody already on file, which is the ghost. */
  ghostsCaught: number;
  ghosts: number;
}

/**
 * The enrollment side. Two questions at once: how often an honest new starter
 * is held up for nothing, and how often somebody enrolling a second time under
 * a new name is caught. Both matter, and they pull against each other.
 */
export function countDuplicates(
  people: readonly StudyPerson[],
  duplicate: number,
): DuplicateCounts {
  const enrolled: KnownFace[] = people.map((person) => ({
    credentialId: person.credentialId,
    employeeId: person.employeeId,
    embedding: person.enrolled,
  }));
  let strangersStopped = 0;
  let ghostsCaught = 0;
  for (const person of people) {
    // A stranger: this person's own enrollment, checked against everybody else.
    const others = enrolled.filter((face) => face.employeeId !== person.employeeId);
    if (bestScore(person.enrolled, others) >= duplicate) {
      strangersStopped += 1;
    }
    // A ghost: another capture of this person, enrolled as a brand-new record,
    // so their own face counts as somebody else's — which is the point.
    const ghostCapture = person.captures[0];
    if (ghostCapture !== undefined && bestScore(ghostCapture, enrolled) >= duplicate) {
      ghostsCaught += 1;
    }
  }
  return {
    strangersStopped,
    strangers: people.length,
    ghostsCaught,
    ghosts: people.filter((person) => person.captures.length > 0).length,
  };
}

function bestScore(embedding: readonly number[], faces: readonly KnownFace[]): number {
  return faces.reduce(
    (highest, face) => Math.max(highest, similarity(embedding, face.embedding)),
    0,
  );
}

/**
 * Where the two sets of scores overlap. `gap` is the distance between the
 * lowest same-person score and the highest different-person score: above zero
 * there is a clean line between them, below zero the two overlap and some
 * mistake is unavoidable whatever number is chosen.
 */
export interface Separation {
  lowestSamePerson: number;
  highestDifferentPerson: number;
  gap: number;
  /** The score that gets the most comparisons right, and how many it misses. */
  bestLine: number;
  mistakesAtBestLine: number;
}

export function separation(spread: ScoreSpread): Separation {
  // A loop, not `Math.min(...scores)`: a study of 200 people has 200,000
  // comparisons, and that many arguments overflows the call stack.
  const lowestSamePerson = spread.samePerson.reduce(
    (lowest, score) => Math.min(lowest, score),
    spread.samePerson.length === 0 ? 0 : 1,
  );
  const highestDifferentPerson = spread.differentPerson.reduce(
    (highest, score) => Math.max(highest, score),
    0,
  );
  let bestLine = 0;
  let fewestMistakes = Number.POSITIVE_INFINITY;
  // Whole steps, not a running total: adding 0.01 a hundred times lands just
  // beside the round numbers, and a comparison against a score of exactly 0.40
  // would then fall the wrong way.
  for (let step = 0; step <= 100; step += 1) {
    const line = step / 100;
    const missed = spread.samePerson.filter((score) => score < line).length;
    const wrong = spread.differentPerson.filter((score) => score >= line).length;
    if (missed + wrong < fewestMistakes) {
      fewestMistakes = missed + wrong;
      bestLine = line;
    }
  }
  return {
    lowestSamePerson,
    highestDifferentPerson,
    gap: lowestSamePerson - highestDifferentPerson,
    bestLine,
    mistakesAtBestLine: fewestMistakes === Number.POSITIVE_INFINITY ? 0 : fewestMistakes,
  };
}

/** A pilot export: captures of real volunteers, which never enter this repository. */
export interface PilotCapture {
  person: string;
  /** The model that made them, checked against `FACE_THRESHOLDS.model`. */
  model?: string;
  /** One capture is three frames; the first is treated as the template. */
  frames: number[][];
}

/**
 * Turns a pilot export into a study set, so real captures and the stand-in are
 * measured by exactly the same code.
 *
 * The file is a list of captures, at least two per person: the first becomes
 * the face they enrolled, the rest become later clock-ins.
 */
export function studyFromPilot(captures: readonly PilotCapture[]): StudyPerson[] {
  const byPerson = new Map<string, number[][][]>();
  for (const capture of captures) {
    if (capture.model !== undefined && capture.model !== FACE_THRESHOLDS.model) {
      throw new Error(
        `A capture says model "${capture.model}"; faces from two models are never compared.`,
      );
    }
    for (const frame of capture.frames) {
      if (frame.length !== FACE_THRESHOLDS.embeddingLength) {
        throw new Error(
          `A frame has ${frame.length} numbers; ${FACE_THRESHOLDS.embeddingLength} are expected.`,
        );
      }
    }
    const list = byPerson.get(capture.person) ?? [];
    list.push(capture.frames);
    byPerson.set(capture.person, list);
  }

  const people: StudyPerson[] = [];
  let index = 0;
  for (const [person, theirCaptures] of byPerson) {
    const first = theirCaptures[0];
    if (theirCaptures.length < 2 || first === undefined || first.length === 0) {
      throw new Error(
        `"${person}" has fewer than two captures; there would be nothing to compare.`,
      );
    }
    index += 1;
    people.push({
      employeeId: person,
      credentialId: `pilot-${index}`,
      enrolled: first[0] as number[],
      captures: theirCaptures.slice(1).map((frames) => frames[0] as number[]),
      frames: first,
    });
  }
  if (people.length < 2) {
    throw new Error('A study needs at least two people, or nobody can be told apart.');
  }
  return people;
}
