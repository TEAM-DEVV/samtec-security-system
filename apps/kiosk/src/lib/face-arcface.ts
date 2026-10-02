/**
 * The face measurer: ArcFace (MobileFaceNet, InsightFace's `w600k_mbf`),
 * run in the browser with onnxruntime-web.
 *
 * It replaced Human's own `faceres` measurer on 2 October 2026, after a real
 * test at a kiosk: a stranger's face scored 0.85–0.89 against the one
 * enrolled worker, above the 0.80 match line, and she was greeted by the
 * worker's name. On the same 43-person photo lab, faceres mixed strangers
 * and owners (best stranger 0.79, equal-error rate 9.4%); this model kept
 * every stranger pair below 0.22 with owners above it (equal-error rate 0%
 * on clean faces). The threshold report, section 13, has the measurements.
 *
 * Human still does everything else: finding the face, the mesh, the head
 * turn, anti-spoofing and liveness. This file only turns a found face into
 * the 512 numbers the server compares. Like every model, it is served from
 * this app's own origin (`/models`, committed and hash-pinned) — never a CDN.
 */
import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';

/** One mesh point from Human: x and y in source pixels (a third value is ignored). */
type MeshPoint = readonly number[];

/** Where ArcFace expects the five landmarks on its 112x112 input. */
const TEMPLATE: readonly [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

const INPUT_SIDE = 112;

/**
 * The five landmarks (image-left eye, image-right eye, nose tip, mouth
 * corners) from Human's 468-point mesh. Eye centres are the midpoint of each
 * eye's two corners; eyes and mouth corners are ordered by where they appear
 * in the image, so a mirrored camera cannot swap them.
 */
export function fivePoints(mesh: readonly MeshPoint[]): [number, number][] {
  const point = (index: number): [number, number] => {
    const found = mesh[index];
    if (found === undefined || found.length < 2) {
      throw new RangeError('the face mesh is missing a landmark');
    }
    return [found[0] as number, found[1] as number];
  };
  const mid = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const eyeA = mid(point(33), point(133));
  const eyeB = mid(point(362), point(263));
  const [leftEye, rightEye] = eyeA[0] <= eyeB[0] ? [eyeA, eyeB] : [eyeB, eyeA];
  const mouthA = point(61);
  const mouthB = point(291);
  const [leftMouth, rightMouth] = mouthA[0] <= mouthB[0] ? [mouthA, mouthB] : [mouthB, mouthA];
  return [leftEye, rightEye, point(1), leftMouth, rightMouth];
}

/**
 * The least-squares rotation + scale + shift that lays `src` onto `dst`
 * (never a mirror image: a mirrored face is a different face). Returned as
 * the numbers a canvas `setTransform(a, b, -b, a, tx, ty)` wants.
 */
export function similarityTransform(
  src: readonly [number, number][],
  dst: readonly [number, number][],
): { a: number; b: number; tx: number; ty: number } {
  const n = src.length;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += (src[i] as [number, number])[0] / n;
    sy += (src[i] as [number, number])[1] / n;
    dx += (dst[i] as [number, number])[0] / n;
    dy += (dst[i] as [number, number])[1] / n;
  }
  let dot = 0;
  let cross = 0;
  let spread = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = (src[i] as [number, number])[0] - sx;
    const ay = (src[i] as [number, number])[1] - sy;
    const bx = (dst[i] as [number, number])[0] - dx;
    const by = (dst[i] as [number, number])[1] - dy;
    dot += ax * bx + ay * by;
    cross += ax * by - ay * bx;
    spread += ax * ax + ay * ay;
  }
  if (spread === 0) {
    throw new RangeError('the landmarks all sit on one point');
  }
  const a = dot / spread;
  const b = cross / spread;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

/**
 * Whether a fitted transform describes a face a kiosk could really be
 * looking at. A garbage mesh still fits *some* transform, and the model
 * would happily measure the garbage; better no numbers than wrong ones.
 */
export function fitIsSane(t: { a: number; b: number; tx: number; ty: number }): boolean {
  if (![t.a, t.b, t.tx, t.ty].every(Number.isFinite)) {
    return false;
  }
  const scale = Math.hypot(t.a, t.b);
  // The crop shrinks a kiosk-sized face (about 2 to 50 times); a scale far
  // outside that means the landmarks were nonsense. And a face rolled more
  // than 45 degrees is not somebody standing at a kiosk.
  return scale > 0.005 && scale < 1.5 && Math.abs(Math.atan2(t.b, t.a)) <= Math.PI / 4;
}

/** What this module needs of the runtime, so a test can hand in a pretend one. */
export interface EmbeddingSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, { data: unknown }>>;
}

export class ArcFaceMeasurer {
  private session: EmbeddingSession | null = null;
  private loading: Promise<void> | null = null;
  private readonly modelBasePath: string;
  private readonly canvas: HTMLCanvasElement;

  constructor(modelBasePath = '/models') {
    this.modelBasePath = modelBasePath;
    this.canvas = document.createElement('canvas');
    this.canvas.width = INPUT_SIDE;
    this.canvas.height = INPUT_SIDE;
  }

  /** Downloads and compiles the model once. A failed try is forgotten, so the next one retries. */
  async prepare(): Promise<void> {
    if (this.session !== null) {
      return;
    }
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    await this.loading;
  }

  private async load(): Promise<void> {
    // The runtime's own worker files come from this app's origin, like the
    // model: the content security policy allows nowhere else.
    env.wasm.wasmPaths = `${this.modelBasePath}/`;
    env.wasm.numThreads = 1;
    this.session = await InferenceSession.create(`${this.modelBasePath}/arcface-mbf.onnx`, {
      executionProviders: ['wasm'],
    });
  }

  /**
   * The 512 numbers for one face: the face is cut out of `source` along its
   * mesh, laid onto the model's 112x112 canvas, and measured.
   */
  async measure(source: CanvasImageSource, mesh: readonly MeshPoint[]): Promise<number[]> {
    await this.prepare();
    const session = this.session;
    if (!session) {
      throw new Error('the face measurer did not load');
    }
    const fit = similarityTransform(fivePoints(mesh), TEMPLATE);
    if (!fitIsSane(fit)) {
      throw new RangeError('the landmarks do not describe a face at a kiosk');
    }
    const { a, b, tx, ty } = fit;
    const paint = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!paint) {
      throw new Error('this browser gave no drawing surface for the face cut-out');
    }
    // Black first, edge to edge: where the warped frame does not cover the
    // crop (a face at the very edge of the camera), the border must be
    // nothing — never the pixels of whoever was measured before.
    paint.resetTransform();
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, INPUT_SIDE, INPUT_SIDE);
    paint.setTransform(a, b, -b, a, tx, ty);
    paint.drawImage(source, 0, 0);
    paint.resetTransform();
    const { data } = paint.getImageData(0, 0, INPUT_SIDE, INPUT_SIDE);

    // RGB, centred on 0 ((value − 127.5) ÷ 127.5), one colour plane at a time.
    const plane = INPUT_SIDE * INPUT_SIDE;
    const values = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i += 1) {
      values[i] = ((data[i * 4] as number) - 127.5) / 127.5;
      values[plane + i] = ((data[i * 4 + 1] as number) - 127.5) / 127.5;
      values[2 * plane + i] = ((data[i * 4 + 2] as number) - 127.5) / 127.5;
    }

    const inputName = session.inputNames[0] ?? 'input.1';
    const outputName = session.outputNames[0] ?? '683';
    const answer = await session.run({
      [inputName]: new Tensor('float32', values, [1, 3, INPUT_SIDE, INPUT_SIDE]),
    });
    const measured = answer[outputName];
    if (!measured) {
      throw new Error('the face measurer answered with nothing');
    }
    return [...(measured.data as Float32Array)];
  }
}
