import type {
  AttemptOutcome,
  AttemptPurpose,
  BiometricConsentStatus,
  CollisionStatus,
  CollisionVerdict,
  DedupeResult,
  ExemptionReason,
  ExemptionStatus,
  FaceStatus,
  KioskDirection,
  RequestExemptionRequest,
} from '@samtec/contracts';

/**
 * Plain words for the biometrics module's codes (docs/plan/13-biometrics-design.md).
 * Each `Record<…>` makes TypeScript fail the build if the contract gains a
 * value without a label. Statuses only: the dashboard never sees an image,
 * a template or a score.
 */

export const consentStatusLabels: Record<BiometricConsentStatus, string> = {
  NONE: 'Not given yet',
  GIVEN: 'Given',
  WITHDRAWN: 'Withdrawn',
};

export const faceStatusLabels: Record<FaceStatus, string> = {
  NONE: 'No face enrolled',
  PENDING: 'Waiting for a second administrator',
  ACTIVE: 'In use',
  BLOCKED: 'Blocked as a duplicate',
  REVOKED: 'Wiped',
};

export const dedupeLabels: Record<DedupeResult, string> = {
  PASSED: 'Looks like nobody else',
  COLLISION: 'Looks like someone already enrolled',
  CLEARED: 'Cleared by a second administrator',
  NOT_CHECKED: 'Not checked (enrolled on a terminal)',
};

export const exemptionStatusLabels: Record<ExemptionStatus, string> = {
  REQUESTED: 'Waiting for a second administrator',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ENDED: 'Ended',
};

export const exemptionReasonLabels: Record<ExemptionReason, string> = {
  DECLINED: 'The worker said no to biometrics',
  CANNOT_ENROLL: 'The kiosk cannot read their face',
  CONSENT_WITHDRAWN: 'The worker withdrew consent',
};

/** The reasons an administrator may give when asking; `CONSENT_WITHDRAWN` is filed by the API. */
export const EXEMPTION_REQUEST_REASONS: readonly RequestExemptionRequest['reason'][] = [
  'DECLINED',
  'CANNOT_ENROLL',
];

export const kioskDirectionLabels: Record<KioskDirection, string> = {
  IN: 'in',
  OUT: 'out',
};

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'MATCHED',
  'AMBIGUOUS',
  'NOT_RECOGNISED',
  'LOW_LIVENESS',
  'FINGERPRINT_REQUESTED',
  'NOT_ME',
  'FALLBACK_REFUSED',
];

export const attemptOutcomeLabels: Record<AttemptOutcome, string> = {
  MATCHED: 'Matched',
  AMBIGUOUS: 'Two people too close to tell',
  NOT_RECOGNISED: 'Not recognised',
  LOW_LIVENESS: 'Face did not look live',
  FINGERPRINT_REQUESTED: 'Fingerprint asked for',
  NOT_ME: 'Cancelled with "Not me"',
  FALLBACK_REFUSED: 'Fallback refused',
};

/** Outcomes worth a second look: someone who keeps failing, or a wrong match. */
export function isWorryingOutcome(outcome: AttemptOutcome): boolean {
  return outcome !== 'MATCHED' && outcome !== 'FINGERPRINT_REQUESTED';
}

export const attemptPurposeLabels: Record<AttemptPurpose, string> = {
  CLOCK: 'Face',
  CO_SIGN: 'Supervisor co-sign',
  STAFF_PASSKEY: 'Staff number, then fingerprint',
};

export const COLLISION_STATUSES: readonly CollisionStatus[] = ['OPEN', 'RESOLVED'];

export const collisionStatusLabels: Record<CollisionStatus, string> = {
  OPEN: 'Open',
  RESOLVED: 'Decided',
};

export const verdictLabels: Record<CollisionVerdict, string> = {
  DIFFERENT_PEOPLE: 'Two different people who look alike',
  SAME_PERSON: 'One person with two records',
};

export function isAttemptOutcome(value: string): value is AttemptOutcome {
  return ATTEMPT_OUTCOMES.some((outcome) => outcome === value);
}

export function isCollisionStatus(value: string): value is CollisionStatus {
  return COLLISION_STATUSES.some((status) => status === value);
}

/** 0.71 → "71% alike". The API sends the score to administrators only. */
export function formatSimilarity(similarity: number): string {
  return `${Math.round(similarity * 100)}% alike`;
}

/** How often the live board asks the API for new punches. */
export const LIVE_BOARD_REFRESH_MS = 5_000;
