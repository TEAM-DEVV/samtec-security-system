import {
  CHALLENGE_SECONDS,
  EMBEDDING_LENGTH,
  FACE_MODEL,
  type FaceEngine,
  type FaceReading,
  type HeadTurn,
} from '@/lib/face';

/**
 * A face engine with no camera and no models.
 *
 * It exists for two reasons. Development: the kiosk's six screens can be built
 * and demonstrated on any machine, in the same way the dashboard is built
 * against a mock API rather than waiting for a backend. And tests: a real engine
 * would need a camera, a face, and 10 MB of model files, and would give a
 * slightly different answer every run — none of which can be asserted against.
 *
 * It fakes the camera and nothing else. Every threshold, the challenge, and the
 * shape of a sample are the real ones from `face.ts`, so a screen that works
 * here works against the real engine. What it cannot prove is whether the real
 * models accept a real face, which is what the Android test in the design page's
 * section 7 is for.
 */

/** How the pretend camera should behave, so a test can ask for each outcome. */
export interface MockFaceOptions {
  /** A face this wide in the frame. Below 224 the reading is refused. */
  facePixels?: number;
  /** The anti-spoofing scores. Below 0.60 the reading is refused. */
  real?: number;
  live?: number;
  /**
   * How the head moves. `follows` turns whichever way it is asked, which is the
   * everyday case; `still` never turns, which is what a printed photograph does.
   */
  head?: 'follows' | 'still';
  /** Which person's face to produce, so two workers are told apart. */
  person?: string;
}

/** How many reads the pretend head stays turned before it looks back. */
const READS_SPENT_TURNED = 2;

/**
 * A pretend camera.
 *
 * It performs the whole gesture by itself once the screen tells it what was
 * asked (`asked`): it reports the turn for a couple of frames, then centres,
 * which is what a person does. That matters beyond the tests — the first version
 * of this class waited for a test to set a field by hand, so in the running app
 * the head never turned, every attempt timed out after twenty seconds, and
 * `pnpm dev:kiosk` could not clock anybody in.
 *
 * A `still` head ignores `asked` entirely, which is exactly what a printed
 * photograph does.
 */
export class MockFaceEngine implements FaceEngine {
  /** The turn currently being performed, and how many reads are left of it. */
  private turningTo: HeadTurn | null = null;
  private readsLeftTurned = 0;
  private started = false;
  private readonly options: Required<MockFaceOptions>;

  constructor(options: MockFaceOptions = {}) {
    this.options = {
      facePixels: options.facePixels ?? 320,
      real: options.real ?? 0.92,
      live: options.live ?? 0.88,
      head: options.head ?? 'follows',
      person: options.person ?? 'somebody',
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  /**
   * The screen has asked for a turn, so the pretend head performs one.
   *
   * A real engine does not need telling — it reads the frame. This one has no
   * head to read, which is why the interface carries the hook.
   */
  asked(turn: HeadTurn): void {
    if (this.options.head === 'still') {
      // A photograph does not turn, however politely it is asked.
      return;
    }
    this.turningTo = turn;
    this.readsLeftTurned = READS_SPENT_TURNED;
  }

  async read(): Promise<FaceReading> {
    if (!this.started) {
      // The same refusal a real engine gives before its models have loaded, so
      // a screen that forgets to start the camera fails here rather than in
      // front of a guard.
      return {
        sample: null,
        facePixels: 0,
        turnedTo: null,
        problem: 'The camera is not ready yet.',
      };
    }
    const { facePixels, real, live, person } = this.options;

    // The turn lasts a couple of frames and then the head comes back to centre,
    // which is the gesture the screen is waiting for.
    let turnedTo: HeadTurn | null = null;
    if (this.turningTo !== null && this.readsLeftTurned > 0) {
      turnedTo = this.turningTo;
      this.readsLeftTurned -= 1;
    } else {
      this.turningTo = null;
    }

    return {
      sample: {
        model: FACE_MODEL,
        embedding: embeddingFor(person),
        real,
        live,
      },
      facePixels,
      turnedTo,
      problem: facePixels === 0 ? 'No face in view. Stand in front of the screen.' : null,
    };
  }

  stop(): void {
    this.started = false;
    this.turningTo = null;
    this.readsLeftTurned = 0;
  }
}

/**
 * A stable pretend face template for a name.
 *
 * The same name always gives the same numbers, and two names give different
 * ones, which is all a screen needs. The numbers are not a real face and are
 * never sent anywhere but a mock: the real API compares these against enrolled
 * templates and would match nobody.
 */
function embeddingFor(person: string): number[] {
  // A small deterministic generator. Not random: a test that runs twice must
  // get the same answer twice.
  let seed = 0;
  for (const character of person) {
    seed = (seed * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }
  const out: number[] = [];
  for (let index = 0; index < EMBEDDING_LENGTH; index += 1) {
    seed = (seed * 48_271) % 2_147_483_647;
    // Centred on zero: faces are compared by angle, and numbers that were all
    // positive would point every name the same way, so all would look alike.
    out.push((seed / 2_147_483_647) * 2 - 1);
  }
  return out;
}

/** How long a screen waits for the head to turn, as milliseconds. */
export const CHALLENGE_MILLISECONDS = CHALLENGE_SECONDS * 1000;
