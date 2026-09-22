import { afterEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { CONSENT_SHA256, CONSENT_TEXT, mockBiometrics, mockCollisions } from '../data/biometrics';
import { mockEmployees } from '../data/employees';
import { resetMockBiometrics } from './biometrics';

// This file resets its own mock store, so it needs no change to test/setup.ts.
afterEach(() => {
  resetMockBiometrics();
});

const enrolled = mockEmployees.find((employee) => employee.biometricEnrolledAt !== null);
const openCollision = mockCollisions.find((collision) => collision.status === 'OPEN');

describe('mock biometrics API', () => {
  it('serves the consent text with a matching SHA-256', async () => {
    await signInForTests('guard@samtec.example');
    const { data } = await fetchClient.GET('/biometrics/consent-text');
    expect(data?.text).toBe(CONSENT_TEXT);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CONSENT_TEXT));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(CONSENT_SHA256);
    expect(data?.sha256).toBe(CONSENT_SHA256);
  });

  it('shows status only, never a template or a score', async () => {
    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: enrolled?.id ?? '' } },
    });
    expect(data?.face.status).toBe('ACTIVE');
    expect(data?.consent.status).toBe('GIVEN');
    expect(JSON.stringify(data)).not.toMatch(/embedding|template|score/i);
  });

  it('hides another site from a supervisor and refuses guards', async () => {
    await signInForTests('supervisor@samtec.example');
    const elsewhere = mockEmployees.find(
      (employee) => employee.currentSite && employee.currentSite.code !== 'ACC-01',
    );
    const hidden = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: elsewhere?.id ?? '' } },
    });
    expect(hidden.response.status).toBe(404);

    await signInForTests('guard@samtec.example');
    const guard = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: enrolled?.id ?? '' } },
    });
    expect(guard.response.status).toBe(403);
  });

  it('lets an ADMIN revoke: the face is wiped and the fingerprint keys are switched off', async () => {
    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      params: { path: { employeeId: enrolled?.id ?? '' } },
      body: { reason: 'Enrolled the wrong person by mistake.' },
    });
    expect(data?.face.status).toBe('REVOKED');
    expect(data?.passkeys.every((key) => key.revokedAt !== null)).toBe(true);
  });

  it('keeps a working guard working after a withdrawal, and hides the note from supervisors', async () => {
    await signInForTests('hr@samtec.example');
    const path = { params: { path: { employeeId: enrolled?.id ?? '' } } };
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometric-consents/withdraw', {
      ...path,
      body: { reason: 'Asked in writing.' },
    });
    expect(data?.consent.status).toBe('WITHDRAWN');
    expect(data?.face.status).toBe('REVOKED');
    expect(data?.exemption).toMatchObject({ status: 'APPROVED', reason: 'CONSENT_WITHDRAWN' });

    await signInForTests('supervisor@samtec.example');
    const seen = await fetchClient.GET('/employees/{employeeId}/biometrics', path);
    expect(seen.data?.exemption?.reason).toBe('CONSENT_WITHDRAWN');
    expect(seen.data?.exemption?.note).toBeNull();
  });

  it('never activates a pending worker by withdrawal, and voids their open review', async () => {
    await signInForTests('hr@samtec.example');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometric-consents/withdraw', {
      params: { path: { employeeId: openCollision?.employee.id ?? '' } },
      body: { reason: 'Asked in writing.' },
    });
    expect(data?.face.status).toBe('REVOKED');
    expect(data?.exemption).toBeNull();

    await signInForTests('admin@samtec.example');
    const voided = await fetchClient.GET('/biometric-collisions', {
      params: { query: { status: 'VOID' } },
    });
    expect(voided.data?.items.map((item) => item.credentialId)).toContain(
      openCollision?.credentialId,
    );
    const decided = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Too late: the face is gone.' },
    });
    expect(decided.response.status).toBe(409);
  });

  it('never lets the enrolling ADMIN decide their own collision', async () => {
    await signInForTests('admin@samtec.example');
    const { data: list } = await fetchClient.GET('/biometric-collisions');
    expect(list?.items.map((item) => item.credentialId)).toContain(openCollision?.credentialId);
    const path = { params: { path: { credentialId: openCollision?.credentialId ?? '' } } };

    // One person with two records: the reviewer must say which record is real.
    const unsure = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: { verdict: 'SAME_PERSON', note: 'Same Ghana Card photo; one person enrolled twice.' },
    });
    expect(unsure.error?.errors?.[0]?.path).toBe('keepEmployeeId');
    const decided = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: {
        verdict: 'SAME_PERSON',
        keepEmployeeId: openCollision?.lookedLike.id ?? '',
        note: 'Same Ghana Card photo; one person enrolled twice.',
      },
    });
    expect(decided.data?.resolution?.keptEmployeeId).toBe(openCollision?.lookedLike.id);
    const again = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Changed my mind.' },
    });
    expect(again.response.status).toBe(409);

    await signInForTests('hr@samtec.example');
    const hr = await fetchClient.GET('/biometric-collisions');
    expect(hr.response.status).toBe(403);
  });

  it('needs a second ADMIN to approve an exemption', async () => {
    await signInForTests('admin@samtec.example');
    const refuser = mockBiometrics.find((row) => row.exemption?.status === 'REQUESTED');
    const path = { params: { path: { employeeId: refuser?.employeeId ?? '' } } };

    // Another ADMIN asked, so this one may decide: here, a rejection.
    const rejected = await fetchClient.POST('/employees/{employeeId}/biometric-exemption/review', {
      ...path,
      body: { decision: 'REJECT', note: 'Try the kiosk once more first.' },
    });
    expect(rejected.data?.exemption?.status).toBe('REJECTED');

    // Asking again makes this ADMIN the one who asked, so they may not approve it.
    const asked = await fetchClient.POST('/employees/{employeeId}/biometric-exemption', {
      ...path,
      body: { reason: 'DECLINED', note: 'Declined again in writing.' },
    });
    expect(asked.data?.exemption?.status).toBe('REQUESTED');
    const own = await fetchClient.POST('/employees/{employeeId}/biometric-exemption/review', {
      ...path,
      body: { decision: 'APPROVE', note: 'Approving my own request.' },
    });
    expect(own.response.status).toBe(403);
  });

  it('refuses an exemption while a duplicate review is open', async () => {
    await signInForTests('admin@samtec.example');
    const { response } = await fetchClient.POST('/employees/{employeeId}/biometric-exemption', {
      params: { path: { employeeId: openCollision?.employee.id ?? '' } },
      body: { reason: 'DECLINED', note: 'Would skip the duplicate check.' },
    });
    expect(response.status).toBe(409);
  });

  it('shows the live punch board newest first, scoped to a supervisor site', async () => {
    await signInForTests('supervisor@samtec.example');
    const { data } = await fetchClient.GET('/attendance/punches', {
      params: { query: { limit: 50 } },
    });
    const sites = new Set(data?.items.map((punch) => punch.siteId));
    expect(sites.size).toBe(1);
    const times = data?.items.map((punch) => punch.serverTime) ?? [];
    expect([...times].sort().reverse()).toEqual(times);
    // Only a kiosk ever records face-and-fingerprint punches.
    expect(
      data?.items
        .filter((punch) => punch.method === 'FACE_PASSKEY')
        .every((punch) => punch.deviceName.startsWith('Kiosk')),
    ).toBe(true);
  });

  it('keeps the kiosk attempts for ADMINs only', async () => {
    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.GET('/attendance/clock-in-attempts', {
      params: { query: { outcome: 'LOW_LIVENESS' } },
    });
    expect(data?.items.every((attempt) => attempt.outcome === 'LOW_LIVENESS')).toBe(true);

    await signInForTests('supervisor@samtec.example');
    const refused = await fetchClient.GET('/attendance/clock-in-attempts');
    expect(refused.response.status).toBe(403);
  });
});
