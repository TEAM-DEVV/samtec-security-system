/**
 * Every number the face rules use, in one place (docs/plan/13-biometrics-design.md
 * section 3). The pilot tunes these numbers, so the set has a name: every
 * clock-in attempt records the name it was judged by, and a later change can
 * never make old attempts look as if they were judged by the new numbers.
 *
 * Nothing else in the code writes a face number of its own.
 */
export const FACE_THRESHOLDS = {
  /** The name stored on every attempt. A changed number means a new name. */
  version: 'ft-1',
  /** The model that made the numbers. Faces from two models are never compared. */
  model: 'human-faceres-1',
  /** How many numbers one face template has. */
  embeddingLength: 1024,
  /** Clock-in: the best score must reach this... */
  match: 0.6,
  /** ...and lead the next person by this much, or the answer is "not sure". */
  lead: 0.05,
  /** Anti-spoofing: `real` and `live` must both reach this, at the kiosk and again here. */
  antiSpoofing: 0.6,
  /** Enrollment: the three frames of one capture must agree with each other this much. */
  frameAgreement: 0.7,
  /**
   * Enrollment: a new face this close to another record is a COLLISION for a
   * second ADMIN to decide. It is looser than a clock-in match on purpose: at
   * enrollment we would rather ask a person than let a ghost through.
   */
  duplicate: 0.5,
} as const;
