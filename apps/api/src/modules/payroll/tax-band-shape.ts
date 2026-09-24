/**
 * Whether a set of PAYE bands covers every income, as a pure function.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decision 12 and the tax table
 * rules. The same shape is enforced by the `tax_bands_shape_valid` trigger in
 * the database, so this is not the only guard — it is the one that turns a bad
 * request into a clear 400 naming the field, instead of a 500 from a trigger.
 *
 * The rule that matters most is the last one. A band with no width has no
 * upper limit, so it takes whatever is left however large. Without exactly one
 * of those, at the end, income above the highest band would simply not be
 * taxed, and nobody would be told: the run would balance, the payslips would
 * add up, and the highest earners would quietly pay nothing on their top
 * slice. That is why `payeOn` in `pay-calculation.ts` throws rather than
 * returning a number when it meets such a table.
 */

/** One band as the contract sends it, before anything is stored. */
export interface ProposedBand {
  ordinal: number;
  widthPesewas: number | null;
  rateBasisPoints: number;
}

/**
 * What is wrong with this set of bands, in plain language, or `null` when
 * nothing is. The message is shown to whoever sent the request, so it says
 * what to change rather than what failed.
 */
export function bandShapeProblem(bands: readonly ProposedBand[]): string | null {
  if (bands.length === 0) {
    return 'A tax table needs at least one band.';
  }

  const ordinals = bands.map((band) => band.ordinal);
  const sorted = [...ordinals].sort((left, right) => left - right);
  const expected = bands.map((_, index) => index + 1);
  if (sorted.some((ordinal, index) => ordinal !== expected[index])) {
    return `The bands must be numbered 1 to ${bands.length} with no gaps and no repeats.`;
  }

  const openBands = bands.filter((band) => band.widthPesewas === null);
  if (openBands.length === 0) {
    return 'The last band must have no width, because the highest rate has no upper limit. Without it the top slice of a high salary would not be taxed.';
  }
  if (openBands.length > 1) {
    return 'Only the last band may have no width. Every band before it needs one, or the bands would overlap.';
  }
  if (openBands[0]?.ordinal !== bands.length) {
    return `Only the last band may have no width, but band ${openBands[0]?.ordinal} of ${bands.length} has none.`;
  }

  return null;
}
