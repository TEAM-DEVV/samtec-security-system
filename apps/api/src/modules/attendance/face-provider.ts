/**
 * The face provider: the only place that opens a sealed face template
 * (docs/plan/13-biometrics-design.md sections 1 and 3). Everything else — the
 * kiosk routes, enrollment, the duplicate review — hands it rows straight from
 * the database and gets back a decision, never the numbers.
 *
 * It keeps no state between requests beyond the key, which suits the hosting.
 * It never logs: templates and samples must not reach a log (CLAUDE.md rule 8),
 * so unreadable rows are counted and reported by id for the caller to log.
 */
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import {
  type FaceSample,
  findDuplicateFace,
  framesAgree,
  type Identification,
  identifyFace,
  type KnownFace,
  sampleProblem,
} from './face-match.js';
import {
  FACE_KEY_VERSION,
  faceTemplateKey,
  openTemplate,
  sealTemplate,
  type TemplateRow,
} from './face-template.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

/** A stored face, exactly as the `biometric_credentials` row holds it. */
export interface SealedFace extends TemplateRow {
  templateSealed: Uint8Array;
}

/** A decision, plus the rows that could not be opened (a damaged or moved template). */
export interface FaceDecision<T> {
  result: T;
  unreadable: string[];
}

/** Who a new face looked like at enrollment, and how closely. */
export interface DuplicateFound {
  credentialId: string;
  employeeId: string;
  score: number;
}

@Injectable()
export class FaceProvider {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = faceTemplateKey(config.authSecret);
  }

  /** The model this server compares: a sample from any other model is refused. */
  get model(): string {
    return FACE_THRESHOLDS.model;
  }

  /** The key version new templates are sealed with. */
  get keyVersion(): number {
    return FACE_KEY_VERSION;
  }

  /** The set of numbers the thresholds came from, stored on every attempt. */
  get thresholdVersion(): string {
    return FACE_THRESHOLDS.version;
  }

  /** Locks a new face away for its row. */
  seal(embedding: readonly number[], row: Omit<TemplateRow, 'keyVersion'>): Buffer {
    return sealTemplate(embedding, { ...row, keyVersion: FACE_KEY_VERSION }, this.key);
  }

  /** Checks a sample before anything else happens with it. */
  check(sample: FaceSample): ReturnType<typeof sampleProblem> {
    return sampleProblem(sample);
  }

  /** The frames of one capture must be the same person (enrollment). */
  framesAgree(frames: readonly (readonly number[])[]): boolean {
    return framesAgree(frames);
  }

  /** Clock-in: compares the sample with the faces in use and says who it is. */
  identify(sample: FaceSample, faces: readonly SealedFace[]): FaceDecision<Identification> {
    const opened = this.open(faces);
    return { result: identifyFace(sample, opened.faces), unreadable: opened.unreadable };
  }

  /** Enrollment: the closest other record, when it is close enough to review. */
  findDuplicate(
    sample: FaceSample,
    faces: readonly SealedFace[],
  ): FaceDecision<DuplicateFound | null> {
    const opened = this.open(faces);
    const found = findDuplicateFace(sample, opened.faces);
    return {
      result: found
        ? { credentialId: found.credentialId, employeeId: found.employeeId, score: found.score }
        : null,
      unreadable: opened.unreadable,
    };
  }

  private open(faces: readonly SealedFace[]): { faces: KnownFace[]; unreadable: string[] } {
    const opened: KnownFace[] = [];
    const unreadable: string[] = [];
    for (const face of faces) {
      const embedding = openTemplate(face.templateSealed, face, this.key);
      if (embedding) {
        opened.push({
          credentialId: face.credentialId,
          employeeId: face.employeeId,
          embedding,
        });
      } else {
        unreadable.push(face.credentialId);
      }
    }
    return { faces: opened, unreadable };
  }
}
