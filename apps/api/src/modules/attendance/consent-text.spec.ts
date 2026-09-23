import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT, CONSENT_TEXT_SHA256, CONSENT_TEXT_VERSION } from './consent-text.js';

/**
 * A consent record keeps the version and the hash of the words the worker
 * agreed to. The two belong together: if the wording is ever edited without a
 * new version, old records would claim agreement to words nobody read. This
 * test fails until whoever edits the text bumps the version and updates the
 * hash here on purpose.
 */
describe('the consent text', () => {
  it('is the version and the exact words we think it is', () => {
    expect(CONSENT_TEXT_VERSION).toBe('bio-v1');
    expect(CONSENT_TEXT_SHA256).toBe(
      '0fa753f2d120d92127e0a00ca1b978002143cd87acb184673c500e2a893f76be',
    );
    expect(CONSENT_TEXT_SHA256).toBe(
      createHash('sha256').update(CONSENT_TEXT, 'utf8').digest('hex'),
    );
  });

  it('tells the worker the things the law asks for', () => {
    for (const promise of [
      'No photograph',
      '90 days',
      'You do not have to agree',
      'change your mind',
      'Data Protection Commission',
    ]) {
      expect(CONSENT_TEXT).toContain(promise);
    }
  });
});
