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

/**
 * A pretend camera.
 *
 * `askedToTurn` is how a test drives the challenge: the screen sets it when it
 * picks a direction, and a `follows` head then reports turning that way.
 */
export class MockFaceEngine implements FaceEngine {
  askedToTurn: HeadTurn | null = null;
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
    const { facePixels, real, live, head, person } = this.options;
    return {
      sample: {
        model: FACE_MODEL,
        embedding: embeddingFor(person),
        real,
        live,
      },
      facePixels,
      turnedTo: head === 'follows' ? this.askedToTurn : null,
      problem: facePixels === 0 ? 'No face in view. Stand in front of the screen.' : null,
    };
  }

  stop(): void {
    this.started = false;
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
    out.push(seed / 2_147_483_647);
  }
  return out;
}

/** How long a screen waits for the head to turn, as milliseconds. */
export const CHALLENGE_MILLISECONDS = CHALLENGE_SECONDS * 1000;
