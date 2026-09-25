/**
 * Rule R3, "paid without presence", as one function two modules share
 * (docs/plan/08-ghost-detection-engine.md §1).
 *
 * It lives here, depending on nothing, because payroll and detection both
 * need the same answer and neither may import the other: **payroll** will
 * refuse a run at submission using the minutes on its own lines, and
 * **detection** raises the alert on its sweep after counting the shifts
 * again. Exporting it from detection would have made payroll import detection
 * and detection import payroll — a circle this codebase does not have
 * anywhere else.
 *
 * **Only detection calls it today.** Payroll has no run endpoints yet
 * (Phase 4), so its half of R3 is owed, and until it lands the sweep alert is
 * the only thing standing between a ghost and a payslip.
 */

/** What the rule starts with: an hour a period (docs/plan/08 §2). */
export const DEFAULT_PRESENCE_TOLERANCE_MINUTES = 60;

/**
 * How far a payslip's hours run beyond the shifts that support them.
 *
 * Zero means there is nothing to ask about, and so does a small overhang: a
 * shift rounded to the minute, or a late clock-out an ADMIN corrected. Only
 * what is **past the tolerance** comes back, so the number is the size of the
 * question rather than the size of the difference.
 */
export function paidBeyondPresence(
  paidMinutes: number,
  presentMinutes: number,
  toleranceMinutes: number = DEFAULT_PRESENCE_TOLERANCE_MINUTES,
): number {
  const beyond = paidMinutes - presentMinutes - toleranceMinutes;
  return beyond > 0 ? beyond : 0;
}
