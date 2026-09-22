import { describe, expect, it } from 'vitest';
import { deriveKey } from '../identity/secret-box.js';
import {
  FACE_KEY_VERSION,
  faceTemplateKey,
  openTemplate,
  sealTemplate,
  type TemplateRow,
} from './face-template.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

const AUTH_SECRET = 'a-test-auth-secret-that-is-long-enough!!!';
const key = faceTemplateKey(AUTH_SECRET);

const row: TemplateRow = {
  companyId: '01927c3e-1111-7aaa-8bbb-000000000001',
  employeeId: '01927c3e-1111-7aaa-8bbb-000000000002',
  credentialId: '01927c3e-1111-7aaa-8bbb-000000000003',
  keyVersion: FACE_KEY_VERSION,
};

const face = Array.from(
  { length: FACE_THRESHOLDS.embeddingLength },
  (_, index) => Math.sin(index) / 3,
);

describe('sealTemplate and openTemplate', () => {
  it('gives back exactly the numbers that were sealed', () => {
    const sealed = sealTemplate(face, row, key);

    expect(openTemplate(sealed, row, key)).toEqual(face);
  });

  it('never stores the same bytes twice for the same face', () => {
    const first = sealTemplate(face, row, key);
    const second = sealTemplate(face, row, key);

    expect(first.equals(second)).toBe(false);
    expect(openTemplate(second, row, key)).toEqual(face);
  });

  it('keeps the numbers out of the stored bytes', () => {
    const sealed = sealTemplate(face, row, key);
    const plain = Buffer.alloc(face.length * 8);
    face.forEach((value, index) => {
      plain.writeDoubleLE(value, index * 8);
    });

    expect(sealed.includes(plain.subarray(0, 64))).toBe(false);
  });

  it('refuses to open a template that was moved to another row', () => {
    const sealed = sealTemplate(face, row, key);

    expect(openTemplate(sealed, { ...row, employeeId: 'someone-else' }, key)).toBeNull();
    expect(openTemplate(sealed, { ...row, credentialId: 'another-row' }, key)).toBeNull();
    expect(openTemplate(sealed, { ...row, companyId: 'another-company' }, key)).toBeNull();
    expect(openTemplate(sealed, { ...row, keyVersion: 2 }, key)).toBeNull();
    // ...and the row it does belong to still opens.
    expect(openTemplate(sealed, row, key)).toEqual(face);
  });

  it('refuses another key, and a key for another purpose', () => {
    const sealed = sealTemplate(face, row, key);

    expect(
      openTemplate(sealed, row, faceTemplateKey('a-different-master-secret-32-chars!!')),
    ).toBeNull();
    expect(openTemplate(sealed, row, deriveKey(AUTH_SECRET, 'device-secret'))).toBeNull();
  });

  it('refuses bytes that were changed, cut short or padded', () => {
    const sealed = sealTemplate(face, row, key);

    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] as number) ^ 0xff;
    expect(openTemplate(changed, row, key)).toBeNull();

    const wrongFormat = Buffer.from(sealed);
    wrongFormat[0] = 2;
    expect(openTemplate(wrongFormat, row, key)).toBeNull();

    expect(openTemplate(sealed.subarray(0, sealed.length - 8), row, key)).toBeNull();
    expect(openTemplate(Buffer.concat([sealed, Buffer.alloc(8)]), row, key)).toBeNull();
    expect(openTemplate(Buffer.alloc(0), row, key)).toBeNull();
  });

  it('refuses a list that is not a face', () => {
    expect(() => sealTemplate([0.1, 0.2], row, key)).toThrow(/1,024 real numbers/);
    const broken = [...face];
    broken[7] = Number.POSITIVE_INFINITY;
    expect(() => sealTemplate(broken, row, key)).toThrow(/1,024 real numbers/);
  });

  it('uses a key of its own, from the one master secret', () => {
    expect(faceTemplateKey(AUTH_SECRET)).toEqual(deriveKey(AUTH_SECRET, 'face-template'));
    expect(faceTemplateKey(AUTH_SECRET)).not.toEqual(deriveKey(AUTH_SECRET, 'device-secret'));
    expect(faceTemplateKey(AUTH_SECRET)).toHaveLength(32);
  });
});
