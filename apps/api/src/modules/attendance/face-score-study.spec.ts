import { describe, expect, it } from 'vitest';
import { findDuplicateFace, identifyFace, type KnownFace, similarity } from './face-match.js';
import {
  type Attempt,
  collectScores,
  countDuplicates,
  countVerdicts,
  DEFAULT_SHAPE,
  lookalikePairsIn,
  makeStudySet,
  offsetForScore,
  scoreAttempts,
  separation,
  studyFromPilot,
  summarise,
  verdictFor,
} from './face-score-study.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

/** A sample in the shape the matcher wants, past the anti-spoofing gate. */
function sampleOf(embedding: number[]) {
  return { embedding, model: FACE_THRESHOLDS.model, real: 0.9, live: 0.9 };
}

describe('offsetForScore', () => {
  it('produces a pair of templates that really score what was asked for', () => {
    for (const wanted of [0.35, 0.5, 0.6, 0.78, 0.95]) {
      const offset = offsetForScore(wanted);
      const first = Array.from({ length: FACE_THRESHOLDS.embeddingLength }, (_v, i) =>
        Math.sin(i / 7),
      );
      // Alternating signs, so the difference is not a flat shift of the list.
      const second = first.map((value, i) => value + (i % 2 === 0 ? offset : -offset));
      expect(similarity(first, second)).toBeCloseTo(wanted, 6);
    }
  });

  it('spans the whole score band, from touching to nothing alike', () => {
    expect(offsetForScore(1)).toBeCloseTo(0.125, 6);
    expect(offsetForScore(0)).toBeCloseTo(0.5, 6);
  });
});

describe('makeStudySet', () => {
  it('gives the same people every time for one seed, and different people for another', () => {
    const [first] = makeStudySet({ ...DEFAULT_SHAPE, people: 3 });
    const [same] = makeStudySet({ ...DEFAULT_SHAPE, people: 3 });
    const [other] = makeStudySet({ ...DEFAULT_SHAPE, people: 3, seed: 7 });
    expect(first?.enrolled).toEqual(same?.enrolled);
    expect(first?.enrolled).not.toEqual(other?.enrolled);
  });

  it('lands near the separation it was asked for', () => {
    const spread = collectScores(makeStudySet({ ...DEFAULT_SHAPE, people: 12, spread: 0 }));
    expect(summarise(spread.samePerson).mean).toBeCloseTo(DEFAULT_SHAPE.sameScore, 1);
    expect(summarise(spread.differentPerson).mean).toBeCloseTo(DEFAULT_SHAPE.differentScore, 1);
    expect(summarise(spread.frames).mean).toBeCloseTo(DEFAULT_SHAPE.frameScore, 1);
  });

  it('refuses a set where different people would score higher than the same person', () => {
    expect(() => makeStudySet({ ...DEFAULT_SHAPE, sameScore: 0.4, differentScore: 0.6 })).toThrow(
      /nothing to separate/,
    );
  });

  it('places look-alike pairs close together, so the lead rule is exercised at all', () => {
    const shape = { ...DEFAULT_SHAPE, people: 8, lookalikePairs: 2, lookalikeScore: 0.68 };
    const people = makeStudySet(shape);
    expect(lookalikePairsIn(shape)).toEqual([
      ['employee-1', 'employee-2'],
      ['employee-3', 'employee-4'],
    ]);
    const pairScore = similarity(people[0]?.enrolled as number[], people[1]?.enrolled as number[]);
    const strangerScore = similarity(
      people[0]?.enrolled as number[],
      people[5]?.enrolled as number[],
    );
    expect(pairScore).toBeGreaterThan(0.55);
    expect(pairScore).toBeGreaterThan(strangerScore + 0.2);
  });

  it('asks for no more pairs than there are people to pair', () => {
    expect(lookalikePairsIn({ ...DEFAULT_SHAPE, people: 3, lookalikePairs: 5 })).toHaveLength(1);
    expect(lookalikePairsIn({ ...DEFAULT_SHAPE, lookalikePairs: 0 })).toEqual([]);
    expect(() => makeStudySet({ ...DEFAULT_SHAPE, people: 3, lookalikePairs: 5 })).not.toThrow();
  });

  it('spreads the scores when asked to, so the report has an overlap to talk about', () => {
    const tight = collectScores(makeStudySet({ ...DEFAULT_SHAPE, people: 12, spread: 0 }));
    const loose = collectScores(makeStudySet({ ...DEFAULT_SHAPE, people: 12, spread: 0.4 }));
    const width = (scores: number[]) => summarise(scores).highest - summarise(scores).lowest;
    expect(width(loose.samePerson)).toBeGreaterThan(width(tight.samePerson));
  });
});

describe('verdictFor', () => {
  const people = makeStudySet({ ...DEFAULT_SHAPE, people: 10 });
  const faces: KnownFace[] = people.map((person) => ({
    credentialId: person.credentialId,
    employeeId: person.employeeId,
    embedding: person.enrolled,
  }));

  it('agrees with the shipped matcher on every attempt, at the shipped numbers', () => {
    for (const person of people) {
      for (const capture of person.captures) {
        const shipped = identifyFace(sampleOf(capture), faces);
        const attempt: Attempt = {
          employeeId: person.employeeId,
          best: shipped.scores.best,
          bestEmployeeId:
            shipped.outcome === 'MATCHED'
              ? shipped.employeeId
              : (bestOf(capture, faces) ?? person.employeeId),
          runnerUp: shipped.scores.runnerUp,
        };
        const mine = verdictFor(attempt, FACE_THRESHOLDS.match, FACE_THRESHOLDS.lead);
        if (shipped.outcome === 'MATCHED') {
          // The study also says *who*, which the matcher only says when it matched.
          expect(mine).toBe(shipped.employeeId === person.employeeId ? 'MATCHED' : 'WRONG_PERSON');
        } else {
          expect(mine).toBe(shipped.outcome);
        }
      }
    }
  });

  it('calls a close second ambiguous rather than guessing', () => {
    const attempt: Attempt = {
      employeeId: 'a',
      best: 0.9,
      bestEmployeeId: 'a',
      runnerUp: 0.87,
    };
    expect(verdictFor(attempt, 0.6, 0.05)).toBe('AMBIGUOUS');
    expect(verdictFor(attempt, 0.6, 0.02)).toBe('MATCHED');
  });

  it('turns a lower bar into fewer refusals and a higher one into more', () => {
    const attempts = scoreAttempts(people);
    const strict = countVerdicts(attempts, 0.9, FACE_THRESHOLDS.lead);
    const loose = countVerdicts(attempts, 0.3, FACE_THRESHOLDS.lead);
    expect(strict.NOT_RECOGNISED).toBeGreaterThan(loose.NOT_RECOGNISED);
    expect(strict.MATCHED).toBeLessThan(loose.MATCHED);
  });

  function bestOf(capture: number[], known: KnownFace[]): string | undefined {
    let best = -1;
    let winner: string | undefined;
    for (const face of known) {
      const score = similarity(capture, face.embedding);
      if (score > best) {
        best = score;
        winner = face.employeeId;
      }
    }
    return winner;
  }
});

describe('countDuplicates', () => {
  const people = makeStudySet({ ...DEFAULT_SHAPE, people: 10 });

  it('agrees with the shipped duplicate check at the shipped number', () => {
    const faces: KnownFace[] = people.map((person) => ({
      credentialId: person.credentialId,
      employeeId: person.employeeId,
      embedding: person.enrolled,
    }));
    const counts = countDuplicates(people, FACE_THRESHOLDS.duplicate);
    const shippedStopped = people.filter(
      (person) => findDuplicateFace(sampleOf(person.enrolled), faces, person.employeeId) !== null,
    ).length;
    expect(counts.strangersStopped).toBe(shippedStopped);

    // A ghost enrolls under a brand-new record, so nothing is excluded as
    // "their own", which is exactly how the real second enrollment looks.
    const shippedCaught = people.filter((person) => {
      const capture = person.captures[0];
      return (
        capture !== undefined && findDuplicateFace(sampleOf(capture), faces, 'brand-new') !== null
      );
    }).length;
    expect(counts.ghostsCaught).toBe(shippedCaught);
  });

  it('catches every ghost once the bar is low, and none once it is impossible', () => {
    expect(countDuplicates(people, 0).ghostsCaught).toBe(people.length);
    expect(countDuplicates(people, 1.01).ghostsCaught).toBe(0);
    expect(countDuplicates(people, 1.01).strangersStopped).toBe(0);
  });
});

describe('separation', () => {
  it('reports a clean gap when the two sets do not overlap', () => {
    const result = separation({
      samePerson: [0.8, 0.85, 0.9],
      differentPerson: [0.2, 0.3, 0.4],
      frames: [],
    });
    expect(result.gap).toBeCloseTo(0.4, 6);
    expect(result.mistakesAtBestLine).toBe(0);
    expect(result.bestLine).toBeGreaterThan(0.4);
    expect(result.bestLine).toBeLessThanOrEqual(0.8);
  });

  it('copes with a study big enough to overflow the call stack', () => {
    // 200 people are 200,000 comparisons. `Math.min(...scores)` dies on that,
    // and a threshold report that crashes on a real-sized company is no report.
    const many = Array.from({ length: 200_000 }, (_value, index) => (index % 100) / 100);
    expect(() => separation({ samePerson: many, differentPerson: many, frames: [] })).not.toThrow();
    expect(separation({ samePerson: many, differentPerson: many, frames: [] }).gap).toBeCloseTo(
      -0.99,
      6,
    );
  });

  it('reports a negative gap, and the fewest mistakes possible, when they overlap', () => {
    const result = separation({
      samePerson: [0.5, 0.8, 0.9],
      differentPerson: [0.2, 0.3, 0.7],
      frames: [],
    });
    expect(result.gap).toBeLessThan(0);
    expect(result.mistakesAtBestLine).toBeGreaterThan(0);
  });
});

describe('studyFromPilot', () => {
  const frame = (offset: number): number[] =>
    Array.from({ length: FACE_THRESHOLDS.embeddingLength }, (_v, i) => Math.sin(i / 5) + offset);

  it('turns captures into people, using the first capture as the enrolled face', () => {
    const people = studyFromPilot([
      { person: 'kwame', frames: [frame(0), frame(0.01), frame(0.02)] },
      { person: 'kwame', frames: [frame(0.03)] },
      { person: 'ama', frames: [frame(1)] },
      { person: 'ama', frames: [frame(1.01)] },
    ]);
    expect(people.map((person) => person.employeeId)).toEqual(['kwame', 'ama']);
    expect(people[0]?.captures).toHaveLength(1);
    expect(people[0]?.frames).toHaveLength(3);
  });

  it('refuses faces from another model, the wrong number of numbers, or one lone capture', () => {
    expect(() =>
      studyFromPilot([
        { person: 'kwame', model: 'some-other-model', frames: [frame(0)] },
        { person: 'ama', frames: [frame(1)] },
      ]),
    ).toThrow(/two models are never compared/);
    expect(() =>
      studyFromPilot([
        { person: 'kwame', frames: [[1, 2, 3]] },
        { person: 'ama', frames: [frame(1)] },
      ]),
    ).toThrow(/are expected/);
    expect(() =>
      studyFromPilot([
        { person: 'kwame', frames: [frame(0)] },
        { person: 'ama', frames: [frame(1)] },
      ]),
    ).toThrow(/fewer than two captures/);
    expect(() =>
      studyFromPilot([
        { person: 'only', frames: [frame(0)] },
        { person: 'only', frames: [frame(0.01)] },
      ]),
    ).toThrow(/at least two people/);
  });
});
