/**
 * Made-up faces for tests, one per "level", where **nearby levels are the
 * same person and levels 0.2 or more apart are strangers**.
 *
 * Faces are compared by angle (cosine), so the old flat test faces — every
 * number the same — would all point the same way and count as one person.
 * Instead, every 0.1 of level has its own independent random face, and a level
 * between two of them is a blend. Independent random faces of 512 numbers
 * are almost exactly at right angles, so strangers score about 0 and never
 * wrap round to look alike again, however far apart their levels are:
 *
 * - the same level scores exactly 1;
 * - levels 0.01 apart score at least 0.97 (two frames of one capture);
 * - levels 0.2 or more apart score below 0.1 (two different people).
 *
 * Deterministic: the same level is the same face on every run.
 */
const LENGTH = 512;
const GRID = 0.1;

/** A repeatable random number generator (mulberry32). */
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

const anchors = new Map<number, number[]>();

function anchor(index: number): number[] {
  const known = anchors.get(index);
  if (known !== undefined) {
    return known;
  }
  const next = randomNumbers(0x9e3779b1 ^ Math.imul(index, 2654435761));
  const face = Array.from({ length: LENGTH }, () => next() * 2 - 1);
  anchors.set(index, face);
  return face;
}

/** The face at this level. */
export function faceAt(level: number): number[] {
  const position = level / GRID;
  const index = Math.floor(position);
  const blend = position - index;
  const from = anchor(index);
  const to = anchor(index + 1);
  return from.map((value, i) => (1 - blend) * value + blend * (to[i] as number));
}
