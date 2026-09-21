import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  clearSession,
  getPendingTwoFactor,
  getSession,
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
  });

  it('remembers a finished sign-in and drops the pending two-factor step', () => {
    setPendingTwoFactor({ step: 'VERIFY', challengeToken: 'challenge' });
    startSession(session);

    expect(getSession()).toEqual(session);
    expect(getPendingTwoFactor()).toBeNull();
  });

  it('forgets everything on clear', () => {
    startSession(session);
    setPendingTwoFactor({ step: 'SETUP', setupToken: 'setup' });
    clearSession();

    expect(getSession()).toBeNull();
    expect(getPendingTwoFactor()).toBeNull();
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
