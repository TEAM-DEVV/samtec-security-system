import { describe, expect, it } from 'vitest';
import { MockBiometricProvider } from './biometric-provider.js';

describe('MockBiometricProvider', () => {
  const provider = new MockBiometricProvider();

  it('identifies an enrolled finger, and nobody for an unknown one', async () => {
    const ama = await provider.enroll('ama', { mockFinger: 'ama-right-thumb' });
    const kofi = await provider.enroll('kofi', { mockFinger: 'kofi-right-thumb' });
    const stored = [
      { employeeId: 'ama', template: ama.template },
      { employeeId: 'kofi', template: kofi.template },
    ];

    await expect(provider.identify(kofi.template, stored)).resolves.toEqual({
      matched: true,
      employeeId: 'kofi',
      score: 1,
    });
    const stranger = await provider.enroll('x', { mockFinger: 'stranger' });
    await expect(provider.identify(stranger.template, stored)).resolves.toEqual({ matched: false });
  });

  it('catches the same finger enrolled under a second name (ghost rule R1)', async () => {
    const first = await provider.enroll('ama', { mockFinger: 'shared-finger' });
    const second = await provider.enroll('ghost', { mockFinger: 'shared-finger' });

    await expect(
      provider.dedupeCheck(second.template, [{ employeeId: 'ama', template: first.template }]),
    ).resolves.toEqual({ status: 'COLLISION', employeeId: 'ama', score: 1 });
    await expect(provider.dedupeCheck(second.template, [])).resolves.toEqual({ status: 'PASSED' });
  });

  it('never stores an image: a template is a format plus a hash', async () => {
    const { template, quality } = await provider.enroll('ama', { mockFinger: 'ama' });
    expect(template.format).toBe('MOCK-1');
    expect(template.data).toMatch(/^[0-9a-f]{64}$/);
    expect(quality).toBe(90);
  });
});
