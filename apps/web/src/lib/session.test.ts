import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  clearSession,
  getPendingTwoFactor,
  getSession,
  mayHaveSession,
  setPendingTwoFactor,
  startSession,
  useSession,
} from './session';

const session = {
  accessToken: 'test-access-token',
  user: {
    id: '01927c3e-2222-7ccc-9ddd-000000000099',
    email: 'test@samtec.example',
    fullName: 'Test Person',
    role: 'SUPERVISOR' as const,
    twoFactorEnabled: false,
    employeeId: null,
  },
};

describe('session', () => {
  it('starts empty', () => {
    expect(getSession()).toBeNull();
    expect(getPendingTwoFactor()).toBeNull();
    expect(mayHaveSession()).toBe(false);
  });

  it('remembers a finished sign-in and drops the pending two-factor step', () => {
    setPendingTwoFactor({ step: 'VERIFY', challengeToken: 'challenge' });
    startSession(session);

    expect(getSession()).toEqual(session);
    expect(getPendingTwoFactor()).toBeNull();
    // The note that tells the next page load a restore is worth trying.
    expect(mayHaveSession()).toBe(true);
  });

  it('forgets everything on clear', () => {
    startSession(session);
    setPendingTwoFactor({ step: 'SETUP', setupToken: 'setup' });
    clearSession();

    expect(getSession()).toBeNull();
    expect(getPendingTwoFactor()).toBeNull();
    expect(mayHaveSession()).toBe(false);
  });

  it('signs this tab out when another tab removes the note', () => {
    startSession(session);

    // What the browser sends to the other tabs when one of them signs out.
    window.dispatchEvent(new StorageEvent('storage', { key: 'samtec-signed-in', newValue: null }));

    expect(getSession()).toBeNull();
  });

  it('ignores a note appearing in another tab: only the API can sign this tab in', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'samtec-signed-in', newValue: '1' }));

    expect(getSession()).toBeNull();
  });

  it('redraws components when the session changes', () => {
    const { result } = renderHook(() => useSession());
    expect(result.current).toBeNull();

    act(() => startSession(session));
    expect(result.current?.user.fullName).toBe('Test Person');

    act(() => clearSession());
    expect(result.current).toBeNull();
  });
});
