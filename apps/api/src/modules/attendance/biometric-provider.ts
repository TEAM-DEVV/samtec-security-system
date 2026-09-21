import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * The seam between SAMTEC and biometric hardware (docs/plan/10). Attendance
 * code talks to this interface only, so the mock (Phase 2) and the real
 * providers (Phase 3: ZKTeco, face kiosk) are interchangeable. Providers keep
 * no state: stored templates are passed in, which suits serverless hosting and
 * keeps the attendance module the only owner of biometric data.
 *
 * Templates only — never images (Data Protection Act 843, docs/plan/06).
 */

/** Nest injection token for "the configured biometric provider". */
export const BIOMETRIC_PROVIDER = Symbol('BIOMETRIC_PROVIDER');

/** A vendor-format template, never an image. */
export interface Template {
  format: string;
  data: string;
}

export interface StoredTemplate {
  employeeId: string;
  template: Template;
}

/** What a capture looks like. Phase 3 adds the real capture shapes. */
export interface CaptureRequest {
  mockFinger: string;
}

export interface EnrollResult {
  template: Template;
  /** 0–100. */
  quality: number;
}

export type MatchResult = { matched: true; employeeId: string; score: number } | { matched: false };

export type CollisionResult =
  | { status: 'PASSED' }
  | { status: 'COLLISION'; employeeId: string; score: number };

export interface BiometricProvider {
  /** Capture and return a new template and its quality. */
  enroll(employeeId: string, capture: CaptureRequest): Promise<EnrollResult>;
  /** 1:N identification: whose finger or face is this? */
  identify(sample: Template, candidates: StoredTemplate[]): Promise<MatchResult>;
  /** The ghost-worker check at enrollment: does this template already belong to someone else? */
  dedupeCheck(template: Template, existing: StoredTemplate[]): Promise<CollisionResult>;
}

/**
 * The deterministic mock: a "finger" is just a name, and its template is a
 * hash of that name. Enrolling the same mock finger under two employees shows
 * the duplicate check (ghost rule R1) catching it, with no hardware at all.
 */
@Injectable()
export class MockBiometricProvider implements BiometricProvider {
  async enroll(_employeeId: string, capture: CaptureRequest): Promise<EnrollResult> {
    return { template: mockTemplate(capture.mockFinger), quality: 90 };
  }

  async identify(sample: Template, candidates: StoredTemplate[]): Promise<MatchResult> {
    const match = candidates.find((candidate) => sameTemplate(candidate.template, sample));
    return match ? { matched: true, employeeId: match.employeeId, score: 1 } : { matched: false };
  }

  async dedupeCheck(template: Template, existing: StoredTemplate[]): Promise<CollisionResult> {
    const clash = existing.find((stored) => sameTemplate(stored.template, template));
    return clash
      ? { status: 'COLLISION', employeeId: clash.employeeId, score: 1 }
      : { status: 'PASSED' };
  }
}

function mockTemplate(mockFinger: string): Template {
  return {
    format: 'MOCK-1',
    data: createHash('sha256').update(`mock-finger:${mockFinger}`).digest('hex'),
  };
}

function sameTemplate(a: Template, b: Template): boolean {
  return a.format === b.format && a.data === b.data;
}
