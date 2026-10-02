import { describe, expect, it } from 'vitest';
import { fitIsSane, fivePoints, similarityTransform } from './face-arcface';

/**
 * The pure half of the measurer: picking the five landmarks out of the mesh,
 * and the transform that lays them onto the model's canvas. Whether the real
 * model tells real faces apart is the photo lab and the phone check
 * (threshold report section 13) — no test runner has a face.
 */

/** A mesh with just the indices the measurer reads, everything else filler. */
function meshWith(points: Record<number, [number, number]>): number[][] {
  const mesh = Array.from({ length: 468 }, () => [0, 0, 0]);
  for (const [index, [x, y]] of Object.entries(points)) {
    mesh[Number(index)] = [x, y, 0];
  }
  return mesh;
}

describe('fivePoints', () => {
  const mesh = meshWith({
    33: [100, 200],
    133: [120, 200], // image-left eye corners
    362: [180, 198],
    263: [200, 198], // image-right eye corners
    1: [150, 240], // nose tip
    61: [120, 280],
    291: [180, 280], // mouth corners
  });

  it('returns eye centres, the nose, and the mouth corners, left to right', () => {
    expect(fivePoints(mesh)).toEqual([
      [110, 200],
      [190, 198],
      [150, 240],
      [120, 280],
      [180, 280],
    ]);
  });

  it('keeps left and right straight even when the camera mirrors the face', () => {
    const mirrored = mesh.map(([x, y, z]) => [640 - (x as number), y, z]) as number[][];
    const [leftEye, rightEye, , leftMouth, rightMouth] = fivePoints(mirrored);
    expect(leftEye?.[0]).toBeLessThan(rightEye?.[0] ?? 0);
    expect(leftMouth?.[0]).toBeLessThan(rightMouth?.[0] ?? 0);
  });

  it('refuses a mesh with a landmark missing', () => {
    expect(() => fivePoints(mesh.slice(0, 100))).toThrow(/missing a landmark/);
  });
});

describe('similarityTransform', () => {
  const apply = (t: { a: number; b: number; tx: number; ty: number }, [x, y]: [number, number]) => [
    t.a * x - t.b * y + t.tx,
    t.b * x + t.a * y + t.ty,
  ];

  it('recovers an exact shift, turn and scale', () => {
    // dst = 2 × (rotate 90°) × src + (10, 20): a point (x, y) lands at (10 − 2y, 20 + 2x).
    const src: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ];
    const dst = src.map(([x, y]) => [10 - 2 * y, 20 + 2 * x] as [number, number]);

    const t = similarityTransform(src, dst);

    for (const [i, point] of src.entries()) {
      const [x, y] = apply(t, point);
      expect(x).toBeCloseTo(dst[i]?.[0] ?? Number.NaN, 10);
      expect(y).toBeCloseTo(dst[i]?.[1] ?? Number.NaN, 10);
    }
  });

  it('finds the least-squares fit when the points do not line up exactly', () => {
    const src: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ];
    // The same square shifted by (3, 4), with one point nudged.
    const dst: [number, number][] = [
      [3, 4],
      [13, 4],
      [13, 14],
      [3, 14.4],
      [8, 9],
    ];

    const t = similarityTransform(src, dst);

    // Still roughly a pure shift: scale about 1, rotation about 0.
    expect(Math.hypot(t.a, t.b)).toBeCloseTo(1, 1);
    expect(t.b).toBeCloseTo(0, 1);
    const [x, y] = apply(t, [5, 5]);
    expect(x).toBeCloseTo(8, 0);
    expect(y).toBeCloseTo(9, 0);
  });

  it('refuses landmarks that all sit on one point', () => {
    const point: [number, number][] = Array.from({ length: 5 }, () => [7, 7]);
    expect(() => similarityTransform(point, point)).toThrow(/one point/);
  });
});

describe('fitIsSane', () => {
  it('accepts the fit a real kiosk face produces', () => {
    // A face about 350 pixels wide, roughly upright: scale ≈ 0.2, no roll.
    expect(fitIsSane({ a: 0.2, b: 0.02, tx: 10, ty: 5 })).toBe(true);
  });

  it('refuses a fit no kiosk face could produce, so garbage is never measured', () => {
    // A mesh of noise fits SOME transform; the model would measure it anyway
    // and hand the server 512 confident, meaningless numbers.
    expect(fitIsSane({ a: Number.NaN, b: 0, tx: 0, ty: 0 })).toBe(false);
    expect(fitIsSane({ a: 900, b: 0, tx: 0, ty: 0 })).toBe(false); // a face 0.1 pixels wide
    expect(fitIsSane({ a: 0.0001, b: 0, tx: 0, ty: 0 })).toBe(false); // a face wider than any camera
    expect(fitIsSane({ a: 0, b: 0.2, tx: 0, ty: 0 })).toBe(false); // rolled 90 degrees
  });
});
