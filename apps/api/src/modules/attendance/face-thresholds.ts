/**
 * Every number the face rules use, in one place (docs/plan/13-biometrics-design.md
 * section 3). The pilot tunes these numbers, so the set has a name: every
 * clock-in attempt records the name it was judged by, and a later change can
 * never make old attempts look as if they were judged by the new numbers.
 *
 * Nothing else in the code writes a face number of its own.
 */
export const FACE_THRESHOLDS = {
  /**
   * The name stored on every attempt. A changed number means a new name.
   *
   * `ft-4` (2 Oct 2026) changed the **model**, not just a number: the kiosk
   * now measures faces with ArcFace instead of Human's faceres, after a real
   * stranger scored 0.85–0.89 against the one enrolled worker under `ft-3`
   * and was greeted by her colleague's name. ArcFace scores live on a
   * different scale (strangers near 0, the same person near 0.9), so these
   * numbers are not comparable with any earlier set.
   */
  version: 'ft-4',
  /** The model that made the numbers. Faces from two models are never compared. */
  model: 'arcface-mbf-1',
  /** How many numbers one face template has. */
  embeddingLength: 512,
  /**
   * Clock-in: the best score must reach this. On the 43-person photo test
   * (threshold report, section 13) the most stranger-like pair of clean,
   * single faces reached 0.212 — and the real stranger from the kiosk
   * incident would have scored near 0. The same person across *different
   * photographs, years apart* sits at 0.90 typically, never below 0.23; at
   * the same kiosk minutes apart they sit far higher. 0.40 leaves a wide
   * margin on both sides. If it ever moves, it moves as `ft-5`.
   */
  match: 0.4,
  /** ...and lead the next person by this much, or the answer is "not sure". */
  lead: 0.05,
  /** Anti-spoofing: `real` and `live` must both reach this, at the kiosk and again here. */
  antiSpoofing: 0.6,
  /**
   * Enrollment: the three frames of one capture must agree with each other
   * this much. They are seconds apart, of one person looking straight at one
   * camera, so they agree far more closely than two different days do.
   */
  frameAgreement: 0.7,
  /**
   * Enrollment: a new face this close to another record is a COLLISION for a
   * second look. It is looser than a clock-in match on purpose: at enrollment
   * we would rather ask a person than let a ghost through. On the photo test,
   * 0.35 still lets every honest stranger enrol (their pairs sit at 0.21 and
   * below) while a second enrollment of the same person (0.9) cannot hide.
   */
  duplicate: 0.35,
} as const;
