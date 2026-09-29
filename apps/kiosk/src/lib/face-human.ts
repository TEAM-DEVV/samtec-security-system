/**
 * The real camera: Human 3.3.6 behind the `FaceEngine` seam.
 *
 * Everything above this file stays ignorant of Human on purpose — the engine
 * is the one part of this system we did not write and cannot fix, so the day
 * it misbehaves the replacement goes in here and no screen changes
 * (`face.ts` explains the seam; docs/plan/02 records the dependency).
 *
 * Three decisions worth knowing:
 *
 * - **The models are served from this app's own origin** (`/models`,
 *   committed in `public/models/`). Never a CDN: a tampered model that always
 *   passes liveness would be invisible, and the content security policy
 *   (`connect-src 'self'`) enforces the choice at runtime.
 * - **The library loads lazily.** Human and its TensorFlow are megabytes; the
 *   everyday screen must not wait for them to paint "Ready". The import
 *   starts with `start()` and stays loaded for the life of the app.
 * - **The mapping from Human's answer to a `FaceReading` is a pure function**
 *   (`readingFrom`), because it is the only part a test runner without a
 *   camera can pin down. Whether the real models accept a real face is the
 *   phone check in docs/plan/13 section 7 — no test here can stand in for it.
 */
import type { FaceSample } from '@samtec/contracts';
import {
  EMBEDDING_LENGTH,
  FACE_MODEL,
  type FaceEngine,
  type FaceReading,
  type HeadTurn,
} from './face';

/** How far the head must turn, in radians of yaw, to count as turned. */
const TURNED_RADIANS = 0.35;
/** …and how close to straight it must come back to count as centred. */
const CENTRED_RADIANS = 0.2;

/**
 * Which way a positive yaw points.
 *
 * The preview is mirrored (a kiosk shows the guard themselves), and Human's
 * yaw sign follows the *image*, not the person. `1` means: positive yaw is
 * the guard turning their head to **their** right. **This is the one value
 * the phone check in docs/plan/13 section 7 must confirm** — if the kiosk
 * only accepts the opposite turn to the one it asks for, flip this to `-1`.
 */
const YAW_SIGN = 1;

/** The slice of Human's `FaceResult` the mapping reads. */
export interface DetectedFace {
  embedding?: number[];
  real?: number;
  live?: number;
  /** `[x, y, width, height]` in video pixels. */
  box: [number, number, number, number];
  rotation?: { angle?: { yaw?: number } } | null;
}

/**
 * Human's answer for one frame, as a `FaceReading` the screens understand.
 * Pure, and the sign convention above is applied here and nowhere else.
 */
export function readingFrom(faces: readonly DetectedFace[]): FaceReading {
  const face = faces[0];
  if (face === undefined) {
    return {
      sample: null,
      facePixels: 0,
      turnedTo: null,
      problem: 'No face in view. Stand in front of the screen.',
    };
  }
  if (faces.length > 1) {
    // Two faces means two people; matching either would punch for somebody
    // who may only be walking past.
    return {
      sample: null,
      facePixels: face.box[2],
      turnedTo: null,
      problem: 'One person at a time, please.',
    };
  }

  const yaw = (face.rotation?.angle?.yaw ?? 0) * YAW_SIGN;
  const turnedTo: HeadTurn | null =
    yaw >= TURNED_RADIANS ? 'RIGHT' : yaw <= -TURNED_RADIANS ? 'LEFT' : null;
  const centred = Math.abs(yaw) <= CENTRED_RADIANS;

  // Between "turned" and "centred" is deliberately nowhere: not a completed
  // turn, and no sample either — `turnedTo: null` with a sample is what the
  // screens read as "centred, send it". Without this dead band a head at a
  // slight angle would count as centred, and one wobble could answer the
  // challenge and supply the sample in a single frame.
  if (turnedTo === null && !centred) {
    return { sample: null, facePixels: face.box[2], turnedTo: null, problem: null };
  }

  if (face.embedding === undefined || face.embedding.length !== EMBEDDING_LENGTH) {
    return {
      sample: null,
      facePixels: face.box[2],
      turnedTo,
      problem: 'The face could not be measured. Hold still a moment.',
    };
  }

  const sample: FaceSample = {
    model: FACE_MODEL,
    embedding: face.embedding,
    real: face.real ?? 0,
    live: face.live ?? 0,
  };
  return {
    sample,
    facePixels: face.box[2],
    turnedTo,
    problem: null,
  };
}

/** What `start()` needs of Human, loaded lazily and kept for the app's life. */
interface LoadedHuman {
  detect: (video: HTMLVideoElement) => Promise<{ face: DetectedFace[] }>;
}

export class HumanFaceEngine implements FaceEngine {
  private readonly modelBasePath: string;
  private human: LoadedHuman | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  constructor(modelBasePath = '/models') {
    this.modelBasePath = modelBasePath;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    if (this.human === null) {
      const { default: Human } = await import('@vladmandic/human');
      const human = new Human({
        modelBasePath: this.modelBasePath,
        // The camera image goes to the model as the camera saw it. Filters are
        // beautification; a matcher must not be fed a beautified face.
        filter: { enabled: false },
        face: {
          enabled: true,
          detector: { modelPath: 'blazeface.json', maxDetected: 2, rotation: true },
          mesh: { enabled: true },
          iris: { enabled: false },
          description: { enabled: true, modelPath: 'faceres.json' },
          emotion: { enabled: false },
          antispoof: { enabled: true, modelPath: 'antispoof.json' },
          liveness: { enabled: true, modelPath: 'liveness.json' },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
        gesture: { enabled: false },
      });
      await human.load();
      await human.warmup();
      this.human = human as unknown as LoadedHuman;
    }
    if (this.stream === null) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // The guard-facing camera, at a size the models are comfortable with.
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    }
    this.video = video;
    video.srcObject = this.stream;
    await video.play();
  }

  async read(): Promise<FaceReading> {
    if (this.human === null || this.video === null || this.video.readyState < 2) {
      return {
        sample: null,
        facePixels: 0,
        turnedTo: null,
        problem: 'The camera is not ready yet.',
      };
    }
    const result = await this.human.detect(this.video);
    return readingFrom(result.face);
  }

  stop(): void {
    // The camera light must go out the moment the screen is done: a kiosk
    // that films the gate all day is not what anybody consented to. The
    // loaded models stay — reloading megabytes for every clock-in would put
    // a guard in the rain for nothing.
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    if (this.video !== null) {
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
