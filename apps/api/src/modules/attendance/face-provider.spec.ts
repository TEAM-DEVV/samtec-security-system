import { describe, expect, it } from 'vitest';
import { AppConfig } from '../../config/app-config.js';
import { parseEnv } from '../../config/env.js';
import { FaceProvider, type SealedFace } from './face-provider.js';
import { FACE_KEY_VERSION } from './face-template.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

const AUTH_SECRET = 'a-face-provider-test-secret-32-chars!!!!';

const config = (authSecret = AUTH_SECRET) =>
  new AppConfig(
    parseEnv({
      DATABASE_URL: 'postgresql://samtec:secret@localhost:5432/samtec_test',
      AUTH_SECRET: authSecret,
    }),
  );

const COMPANY = '01927c3e-2222-7aaa-8bbb-000000000001';
const face = (level: number) =>
  Array.from({ length: FACE_THRESHOLDS.embeddingLength }, () => level);

const sample = (level: number, extra: Record<string, unknown> = {}) => ({
  model: FACE_THRESHOLDS.model,
  embedding: face(level),
  real: 0.9,
  live: 0.9,
  ...extra,
});

/** A stored face row, sealed the way enrollment will seal it. */
const stored = (
  provider: FaceProvider,
  employeeId: string,
  credentialId: string,
  level: number,
): SealedFace => {
  const row = { companyId: COMPANY, employeeId, credentialId };
  return {
    ...row,
    keyVersion: FACE_KEY_VERSION,
    templateSealed: provider.seal(face(level), row),
  };
};

describe('FaceProvider', () => {
  const provider = new FaceProvider(config());
  const kwame = stored(provider, 'kwame', 'face-kwame', 0);
  const ama = stored(provider, 'ama', 'face-ama', 0.6);

  it('says which model, key version and thresholds it works to', () => {
    expect(provider.model).toBe('human-faceres-1');
    expect(provider.keyVersion).toBe(1);
    expect(provider.thresholdVersion).toBe('ft-1');
  });

  it('opens the faces it sealed and names the person at clock-in', () => {
    const decision = provider.identify(sample(0.2), [kwame, ama]);

    expect(decision.unreadable).toEqual([]);
    expect(decision.result.outcome).toBe('MATCHED');
    expect(decision.result.outcome === 'MATCHED' && decision.result.employeeId).toBe('kwame');
  });

  it('finds the closest record at enrollment, and nobody for a new face', () => {
    expect(provider.findDuplicate(sample(0.2), [kwame, ama]).result?.employeeId).toBe('kwame');
    expect(provider.findDuplicate(sample(1.2), [kwame, ama]).result).toBeNull();
  });

  it('skips a template it cannot open, and says which row it was', () => {
    // The same sealed bytes, listed under another worker's row.
    const moved: SealedFace = { ...kwame, employeeId: 'ghost', credentialId: 'face-ghost' };

    const decision = provider.identify(sample(0.2), [moved, ama]);

    expect(decision.unreadable).toEqual(['face-ghost']);
    expect(decision.result.outcome).toBe('NOT_RECOGNISED');
  });

  it('opens nothing sealed under another master secret', () => {
    const other = new FaceProvider(config('a-completely-different-secret-32-ch!!'));

    const decision = other.identify(sample(0.2), [kwame, ama]);

    expect(decision.unreadable).toEqual(['face-kwame', 'face-ama']);
    expect(decision.result.outcome).toBe('NOT_RECOGNISED');
  });

  it('checks a sample and the frames of a capture before anything is stored', () => {
    expect(provider.check(sample(0))).toBeNull();
    expect(provider.check(sample(0, { live: 0.2 }))).toBe('LOW_LIVENESS');
    expect(provider.check(sample(0, { model: 'another-model' }))).toBe('WRONG_MODEL');

    expect(provider.framesAgree([face(0), face(0.05), face(0.1)])).toBe(true);
    expect(provider.framesAgree([face(0), face(0.6), face(0.1)])).toBe(false);
  });

  it('seals a new face for its own row only', () => {
    const sealed = provider.seal(face(0.3), {
      companyId: COMPANY,
      employeeId: 'new-starter',
      credentialId: 'face-new',
    });
    const row: SealedFace = {
      companyId: COMPANY,
      employeeId: 'new-starter',
      credentialId: 'face-new',
      keyVersion: FACE_KEY_VERSION,
      templateSealed: sealed,
    };

    expect(provider.identify(sample(0.3), [row]).result.outcome).toBe('MATCHED');
    expect(
      provider.identify(sample(0.3), [{ ...row, employeeId: 'someone-else' }]).unreadable,
    ).toEqual(['face-new']);
  });
});
