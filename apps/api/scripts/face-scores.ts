/**
 * The threshold report (docs/plan/13-biometrics-design.md section 7,
 * docs/guides/14-face-threshold-report.md): how far apart same-person and
 * different-person faces score, and what each of the five `ft-1` numbers
 * would decide.
 *
 * It needs no database and no API. Everything it prints comes from the shipped
 * matcher in `src/modules/attendance/face-match.ts`, so the report and the
 * kiosk can never disagree about what "alike" means.
 *
 *   pnpm --filter @samtec/api face:scores
 *
 * That run uses a **stand-in** set of faces, generated to a chosen separation.
 * It is not a measurement of real faces, and the report says so in the same
 * words. What it does prove is how the decisions move as the numbers move,
 * which is the part a reader can check.
 *
 * With real pilot captures (10 or more consenting volunteers, exported from
 * the kiosk):
 *
 *   pnpm --filter @samtec/api face:scores -- --from ../../pilot-captures.json
 *
 * The file is a list of `{ "person": "…", "frames": [[…1024 numbers…], …] }`,
 * at least two captures per person. **It is biometric data:** keep it outside
 * this repository, and delete it when the report is written.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type Attempt,
  collectScores,
  countDuplicates,
  countVerdicts,
  DEFAULT_SHAPE,
  makeStudySet,
  type PilotCapture,
  type StudyPerson,
  type Summary,
  scoreAttempts,
  separation,
  studyFromPilot,
  summarise,
} from '../src/modules/attendance/face-score-study.js';
import { FACE_THRESHOLDS } from '../src/modules/attendance/face-thresholds.js';

const { values } = parseArgs({
  // pnpm passes its `--` separator through, which would end the options.
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    /** A pilot export. Without it the run uses the stand-in set. */
    from: { type: 'string' },
    people: { type: 'string', default: String(DEFAULT_SHAPE.people) },
    captures: { type: 'string', default: String(DEFAULT_SHAPE.capturesEach) },
    /** The stand-in's mean same-person and different-person scores. */
    same: { type: 'string', default: String(DEFAULT_SHAPE.sameScore) },
    different: { type: 'string', default: String(DEFAULT_SHAPE.differentScore) },
    spread: { type: 'string', default: String(DEFAULT_SHAPE.spread) },
    /** Pairs of people placed deliberately close, so the lead rule is exercised. */
    lookalikes: { type: 'string', default: String(DEFAULT_SHAPE.lookalikePairs) },
    seed: { type: 'string', default: String(DEFAULT_SHAPE.seed) },
  },
});

const { people, source } = await loadPeople();
const spread = collectScores(people);
const attempts = scoreAttempts(people);
const captureCount = people.reduce((total, person) => total + person.captures.length, 0);

console.log(`\nFace threshold report — ${source}`);
console.log(
  `${people.length} people, ${captureCount} clock-in captures, ${spread.samePerson.length + spread.differentPerson.length} comparisons.`,
);
console.log(`Threshold set ${FACE_THRESHOLDS.version}, model ${FACE_THRESHOLDS.model}.\n`);

printThresholds();
printSpread();
printSeparation();
printClockIn();
printMatchTuning();
printLeadTuning();
printEnrollment();
printFrames();
printClosing();

function printThresholds(): void {
  heading('1. The numbers under test');
  const rows = [
    ['match', FACE_THRESHOLDS.match, 'a clock-in needs at least this score'],
    ['lead', FACE_THRESHOLDS.lead, 'and this much more than the runner-up'],
    ['duplicate', FACE_THRESHOLDS.duplicate, 'a new face this close to another record is queried'],
    [
      'frameAgreement',
      FACE_THRESHOLDS.frameAgreement,
      'the three frames of one capture must agree',
    ],
    ['antiSpoofing', FACE_THRESHOLDS.antiSpoofing, 'the kiosk must be this sure it is a live face'],
  ] as const;
  for (const [name, value, why] of rows) {
    console.log(`  ${name.padEnd(16)} ${String(value).padEnd(6)} ${why}`);
  }
  console.log();
}

function printSpread(): void {
  heading('2. How the scores spread');
  console.log('                    count   lowest    5%   middle    95%  highest    mean');
  printSummary('same person', summarise(spread.samePerson));
  printSummary('other people', summarise(spread.differentPerson));
  console.log();
  console.log('  same person      ' + histogram(spread.samePerson));
  console.log('  other people     ' + histogram(spread.differentPerson));
  console.log('                   0.0      0.2      0.4      0.6      0.8      1.0');
  console.log();
}

function printSeparation(): void {
  const result = separation(spread);
  heading('3. Is there a clean line between them?');
  console.log(`  lowest same-person score      ${fixed(result.lowestSamePerson)}`);
  console.log(`  highest other-person score    ${fixed(result.highestDifferentPerson)}`);
  console.log(
    `  gap                          ${fixed(result.gap)}   ${
      result.gap > 0
        ? 'no overlap: some score separates every comparison correctly'
        : 'they overlap: some mistake is unavoidable, whatever number is chosen'
    }`,
  );
  console.log(
    `  best single line             ${fixed(result.bestLine)}   ${result.mistakesAtBestLine} of ${
      spread.samePerson.length + spread.differentPerson.length
    } comparisons wrong there`,
  );
  console.log(
    `  shipped match                ${fixed(FACE_THRESHOLDS.match)}   ${
      FACE_THRESHOLDS.match <= result.bestLine ? 'below' : 'above'
    } the best line, which errs towards asking rather than guessing`,
  );
  console.log();
}

function printClockIn(): void {
  heading(`4. Clock-in at ${FACE_THRESHOLDS.version}`);
  const counts = countVerdicts(attempts, FACE_THRESHOLDS.match, FACE_THRESHOLDS.lead);
  const of = attempts.length;
  console.log(`  matched, right person   ${share(counts.MATCHED, of)}   paid`);
  console.log(
    `  matched, WRONG person   ${share(counts.WRONG_PERSON, of)}   the one that must be 0`,
  );
  console.log(`  not sure (lead rule)    ${share(counts.AMBIGUOUS, of)}   falls back, flagged`);
  console.log(
    `  not recognised          ${share(counts.NOT_RECOGNISED, of)}   tries again, then falls back`,
  );
  console.log();
  console.log('  Nobody is turned away: after three failures a staff number plus a finger is');
  console.log('  allowed, and the punch carries the flag. So a high "not sure" costs patience,');
  console.log('  and a single "wrong person" costs the whole idea.');
  console.log();
}

function printMatchTuning(): void {
  heading('5. What moving `match` would do');
  console.log('  match   matched  wrong  not sure  not recognised');
  for (const match of [0.5, 0.55, 0.6, 0.65, 0.7, 0.8]) {
    const counts = countVerdicts(attempts, match, FACE_THRESHOLDS.lead);
    const mark = match === FACE_THRESHOLDS.match ? ' <- shipped' : '';
    console.log(
      `  ${fixed(match)}   ${pad(counts.MATCHED)}  ${pad(counts.WRONG_PERSON)}  ${pad(
        counts.AMBIGUOUS,
      )}      ${pad(counts.NOT_RECOGNISED)}${mark}`,
    );
  }
  console.log();
}

function printLeadTuning(): void {
  heading('6. What moving `lead` would do');
  console.log('  lead    matched  wrong  not sure  not recognised');
  for (const lead of [0, 0.02, 0.05, 0.1, 0.2]) {
    const counts = countVerdicts(attempts, FACE_THRESHOLDS.match, lead);
    const mark = lead === FACE_THRESHOLDS.lead ? ' <- shipped' : '';
    console.log(
      `  ${fixed(lead)}   ${pad(counts.MATCHED)}  ${pad(counts.WRONG_PERSON)}  ${pad(
        counts.AMBIGUOUS,
      )}      ${pad(counts.NOT_RECOGNISED)}${mark}`,
    );
  }
  // What the lead rule actually bought on *this* data, rather than a claim.
  const without = countVerdicts(attempts, FACE_THRESHOLDS.match, 0);
  const with_ = countVerdicts(attempts, FACE_THRESHOLDS.match, FACE_THRESHOLDS.lead);
  console.log('  A lead of 0 means the highest score always wins, however close the second.');
  if (without.WRONG_PERSON > 0) {
    console.log(
      `  Here it would pay the wrong person ${without.WRONG_PERSON} times; the lead rule turns those`,
    );
    console.log('  into a second try instead.');
  } else {
    console.log(
      '  Here the right person won every attempt even with no lead at all, so the rule is',
    );
    console.log(
      `  insurance, not a fix: it turned ${with_.AMBIGUOUS} narrow wins into a second try. The case it`,
    );
    console.log('  guards against — a look-alike scoring above you — is the one a generated set');
    console.log('  cannot manufacture, and the one the pilot must go looking for.');
  }
  console.log();
}

function printEnrollment(): void {
  heading('7. Enrollment: catching a second enrollment of the same person');
  console.log('  duplicate  ghosts caught  strangers wrongly queried');
  for (const duplicate of [0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    const counts = countDuplicates(people, duplicate);
    const mark = duplicate === FACE_THRESHOLDS.duplicate ? ' <- shipped' : '';
    console.log(
      `  ${fixed(duplicate)}      ${share(counts.ghostsCaught, counts.ghosts)}  ${share(
        counts.strangersStopped,
        counts.strangers,
      )}${mark}`,
    );
  }
  console.log();
  console.log('  A ghost here is somebody already enrolled, enrolling again under a new record —');
  console.log('  the fraud the whole system exists to stop. A stranger wrongly queried only');
  console.log('  costs a second administrator a minute, which is why this number is looser');
  console.log(`  (${FACE_THRESHOLDS.duplicate}) than a clock-in (${FACE_THRESHOLDS.match}).`);
  console.log();
}

function printFrames(): void {
  heading('8. The three frames of one capture');
  const summary = summarise(spread.frames);
  console.log('                    count   lowest    5%   middle    95%  highest    mean');
  printSummary('frame pairs', summary);
  const refused = spread.frames.filter((score) => score < FACE_THRESHOLDS.frameAgreement).length;
  console.log(
    `\n  At ${FACE_THRESHOLDS.frameAgreement}, ${refused} of ${summary.count} frame pairs would be refused as disagreeing.`,
  );
  console.log('  Frames are moments apart, so they should agree far more closely than two');
  console.log('  captures on different days. A refusal here means one person started the');
  console.log('  capture and another finished it — or the camera lost the face.');
  console.log();
}

function printClosing(): void {
  heading('9. What this run does and does not show');
  if (values.from === undefined) {
    console.log('  These are STAND-IN faces, generated to a chosen separation. They show how the');
    console.log('  decisions move as the numbers move; they are NOT a measurement of real faces,');
    console.log(`  and they cannot confirm ${FACE_THRESHOLDS.version} for production.`);
    console.log();
    console.log('  To confirm it: 10 or more consenting volunteers, several captures each, across');
    console.log('  the light and the phones the sites really use, then');
    console.log('    pnpm --filter @samtec/api face:scores -- --from <export.json>');
    console.log('  and put the numbers in docs/guides/14-face-threshold-report.md.');
  } else {
    console.log('  These are REAL captures. The numbers above are a measurement, and they are');
    console.log(`  what ${FACE_THRESHOLDS.version} should be confirmed or changed against.`);
    console.log('  Delete the export when the report is written: it is biometric data.');
  }
  console.log();
}

async function loadPeople(): Promise<{ people: StudyPerson[]; source: string }> {
  if (values.from !== undefined) {
    const text = await readFile(values.from, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('The pilot file must be a list of captures.');
    }
    return {
      people: studyFromPilot(parsed as PilotCapture[]),
      source: `real pilot captures from ${values.from}`,
    };
  }
  const shape = {
    people: whole(values.people, 'people', 2, 500),
    capturesEach: whole(values.captures, 'captures', 1, 50),
    sameScore: fraction(values.same, 'same'),
    differentScore: fraction(values.different, 'different'),
    frameScore: DEFAULT_SHAPE.frameScore,
    lookalikePairs: whole(values.lookalikes, 'lookalikes', 0, 100),
    lookalikeScore: DEFAULT_SHAPE.lookalikeScore,
    spread: fraction(values.spread, 'spread'),
    seed: whole(values.seed, 'seed', 1, Number.MAX_SAFE_INTEGER),
  };
  return {
    people: makeStudySet(shape),
    source: `STAND-IN faces (same ${shape.sameScore}, different ${shape.differentScore}, spread ${shape.spread}, ${shape.lookalikePairs} look-alike pairs at ${shape.lookalikeScore}, seed ${shape.seed})`,
  };
}

function whole(value: string | undefined, name: string, least: number, most: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < least || parsed > most) {
    throw new Error(`--${name} must be a whole number from ${least} to ${most}.`);
  }
  return parsed;
}

function fraction(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--${name} must be a number from 0 to 1.`);
  }
  return parsed;
}

function heading(text: string): void {
  console.log(text);
  console.log('-'.repeat(text.length));
}

function printSummary(label: string, summary: Summary): void {
  const figures = [
    summary.lowest,
    summary.fifth,
    summary.middle,
    summary.ninetyFifth,
    summary.highest,
    summary.mean,
  ]
    .map((value) => fixed(value).padStart(6))
    .join('  ');
  console.log(`  ${label.padEnd(16)} ${String(summary.count).padStart(6)}   ${figures}`);
}

/** Twenty buckets of 0.05, as a row of blocks — enough to see the two humps. */
function histogram(scores: readonly number[]): string {
  const buckets = new Array<number>(20).fill(0);
  for (const score of scores) {
    const bucket = Math.min(19, Math.max(0, Math.floor(score * 20)));
    buckets[bucket] = (buckets[bucket] as number) + 1;
  }
  const tallest = Math.max(1, ...buckets);
  const blocks = [' ', '.', ':', '|', '#'];
  return buckets
    .map((count) => {
      if (count === 0) {
        return ' ';
      }
      const level = Math.ceil((count / tallest) * (blocks.length - 1));
      return blocks[level] as string;
    })
    .join('  ');
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function pad(value: number): string {
  return String(value).padStart(7);
}

function share(count: number, of: number): string {
  const percent = of === 0 ? 0 : (count / of) * 100;
  return `${String(count).padStart(5)} of ${String(of).padEnd(5)} (${percent.toFixed(1).padStart(5)}%)`;
}
