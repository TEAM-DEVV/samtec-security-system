import { describe, expect, it } from 'vitest';
import { bandShapeProblem, type ProposedBand } from './tax-band-shape.js';

/** The 2026 bands from the design page, shortened to three. */
const GOOD: ProposedBand[] = [
  { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
  { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
  { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 },
];

describe('the shape a set of PAYE bands must have', () => {
  it('accepts bands numbered from one with an open band last', () => {
    expect(bandShapeProblem(GOOD)).toBeNull();
  });

  it('accepts them in any order, because the ordinal is what counts', () => {
    expect(bandShapeProblem([...GOOD].reverse())).toBeNull();
  });

  it('accepts a single open band, which is a flat rate on everything', () => {
    expect(
      bandShapeProblem([{ ordinal: 1, widthPesewas: null, rateBasisPoints: 1000 }]),
    ).toBeNull();
  });

  it('refuses no bands at all', () => {
    expect(bandShapeProblem([])).toMatch(/at least one band/);
  });

  it('refuses a gap in the numbering', () => {
    const gapped = [
      { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
      { ordinal: 3, widthPesewas: null, rateBasisPoints: 3500 },
    ];
    expect(bandShapeProblem(gapped)).toMatch(/no gaps/);
  });

  it('refuses the same number twice', () => {
    const repeated = [
      { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
      { ordinal: 1, widthPesewas: null, rateBasisPoints: 3500 },
    ];
    expect(bandShapeProblem(repeated)).toMatch(/no repeats/);
  });

  it('refuses a table whose every band has an upper limit', () => {
    // This is the one that would cost real money: the income above the top
    // band would be taxed at nothing at all, silently.
    const bounded = GOOD.map((band) => ({ ...band, widthPesewas: band.widthPesewas ?? 200_000 }));
    expect(bandShapeProblem(bounded)).toMatch(/no upper limit/);
  });

  it('refuses two open bands, which would overlap', () => {
    const twoOpen = [
      { ordinal: 1, widthPesewas: null, rateBasisPoints: 0 },
      { ordinal: 2, widthPesewas: null, rateBasisPoints: 3500 },
    ];
    expect(bandShapeProblem(twoOpen)).toMatch(/Only the last band/);
  });

  it('refuses an open band that is not the last one', () => {
    const openInTheMiddle = [
      { ordinal: 1, widthPesewas: null, rateBasisPoints: 0 },
      { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
    ];
    expect(bandShapeProblem(openInTheMiddle)).toMatch(/band 1 of 2/);
  });
});
