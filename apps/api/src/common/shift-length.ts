/**
 * How long a shift pattern is, as one function two modules share.
 *
 * It lives here, depending on nothing, because payroll and workforce both need
 * the same answer and neither may import the other: **payroll** compares a
 * day's worked minutes against it to find overtime, and **workforce** reports
 * what each date of a posting was scheduled for. Two copies of this arithmetic
 * would agree on the day they were written and drift afterwards, and the one
 * that decides real pay would be the untested one.
 *
 * The same reasoning put `paid-beyond-presence.ts` beside it.
 */

/** Minutes in a day, which is what makes a night shift work. */
const DAY_MINUTES = 1440;

/**
 * The length of a shift in minutes.
 *
 * Both ends are minutes from midnight, so a night shift ends with a smaller
 * number than it started with — 22:00 to 06:00 is 1320 to 360. Wrapping by a
 * whole day turns that into the eight hours it really is, rather than the
 * negative sixteen a plain subtraction gives.
 */
export function shiftLengthMinutes(startMinutes: number, endMinutes: number): number {
  return (endMinutes - startMinutes + DAY_MINUTES) % DAY_MINUTES;
}
