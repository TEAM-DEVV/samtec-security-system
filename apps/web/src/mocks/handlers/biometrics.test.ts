import type { ResolveCollisionRequest } from '@samtec/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { CONSENT_SHA256, CONSENT_TEXT, mockBiometrics, mockCollisions } from '../data/biometrics';
import { mockEmployees } from '../data/employees';
import { mockUsers } from '../data/users';
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

  it('files an exemption request on a withdrawal, which a different ADMIN must decide', async () => {
    // Only an ADMIN records a withdrawal.
    await signInForTests('hr@samtec.example');
    const path = { params: { path: { employeeId: enrolled?.id ?? '' } } };
    const byHr = await fetchClient.POST('/employees/{employeeId}/biometric-consents/withdraw', {
      ...path,
      body: { reason: 'Asked in writing.' },
    });
    expect(byHr.response.status).toBe(403);

    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometric-consents/withdraw', {
      ...path,
      body: { reason: 'Asked in writing.' },
    });
    expect(data?.consent.status).toBe('WITHDRAWN');
    expect(data?.face.status).toBe('REVOKED');
    // Only a request: a wiped face is out of the duplicate check, so a second person must vouch.
    expect(data?.exemption).toMatchObject({ status: 'REQUESTED', reason: 'CONSENT_WITHDRAWN' });
    const own = await fetchClient.POST('/employees/{employeeId}/biometric-exemption/review', {
      ...path,
      body: { decision: 'APPROVE', note: 'Approving my own withdrawal.' },
    });
    expect(own.response.status).toBe(403);
    // Nor can a revoke quietly end the request: only a second ADMIN may close it.
    const revoke = await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      ...path,
      body: { reason: 'Closing the request myself.' },
    });
    expect(revoke.response.status).toBe(409);

    await signInForTests('supervisor@samtec.example');
    const seen = await fetchClient.GET('/employees/{employeeId}/biometrics', path);
    expect(seen.data?.exemption?.status).toBe('REQUESTED');
    expect(seen.data?.exemption?.reason).toBe('CONSENT_WITHDRAWN');
    expect(seen.data?.exemption?.note).toBeNull();
  });

  it('never lets whoever wiped a face decide a collision of either record', async () => {
    await signInForTests('admin@samtec.example');
    await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      params: { path: { employeeId: openCollision?.lookedLike.id ?? '' } },
      body: { reason: 'Re-enrolling this guard.' },
    });
    const decided = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Deciding after wiping one of the faces.' },
    });
    expect(decided.response.status).toBe(403);
  });

  it('never activates a pending worker by withdrawal, and keeps their review open', async () => {
    await signInForTests('admin@samtec.example');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometric-consents/withdraw', {
      params: { path: { employeeId: openCollision?.employee.id ?? '' } },
      body: { reason: 'Asked in writing.' },
    });
    expect(data?.face.status).toBe('REVOKED');
    expect(data?.exemption).toBeNull();

    // The review stays open for a second ADMIN; the one who wiped the face may not decide it.
    const open = await fetchClient.GET('/biometric-collisions');
    expect(open.data?.items.map((item) => item.credentialId)).toContain(
      openCollision?.credentialId,
    );
    const decided = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Both Ghana Cards checked in person.' },
    });
    expect(decided.response.status).toBe(403);
  });

  it('clears a face that is still there when a second ADMIN says different people', async () => {
    await signInForTests('admin@samtec.example');
    await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Both Ghana Cards checked in person.' },
    });
    const after = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: openCollision?.employee.id ?? '' } },
    });
    expect(after.data?.face).toMatchObject({ status: 'ACTIVE', dedupe: 'CLEARED' });
  });

  it('refuses a revoke while a duplicate review is open', async () => {
    await signInForTests('admin@samtec.example');
    const { response } = await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      params: { path: { employeeId: openCollision?.employee.id ?? '' } },
      body: { reason: 'Would wipe the question away.' },
    });
    expect(response.status).toBe(409);
  });

  it('never lets the enrolling ADMIN decide their own collision', async () => {
    await signInForTests('admin@samtec.example');
    // The mock admin enrolled the decided collision: the second-person rule answers first.
    const adminId = mockUsers.find((user) => user.email === 'admin@samtec.example')?.id;
    const own = mockCollisions.find((collision) => collision.enrolledByUserId === adminId);
    const { response } = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: own?.credentialId ?? '' } },
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Deciding my own enrollment.' },
    });
    expect(response.status).toBe(403);

    await signInForTests('hr@samtec.example');
    const hr = await fetchClient.GET('/biometric-collisions');
    expect(hr.response.status).toBe(403);
  });

  it('makes SAME_PERSON name the record to keep, and blocks the other one for good', async () => {
    await signInForTests('admin@samtec.example');
    const path = { params: { path: { credentialId: openCollision?.credentialId ?? '' } } };
    const missingKeep = {
      verdict: 'SAME_PERSON',
      note: 'Same Ghana Card photo; one person enrolled twice.',
    } as unknown as ResolveCollisionRequest;
    const unsure = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: missingKeep,
    });
    expect(unsure.error?.errors?.[0]?.path).toBe('keepEmployeeId');
    const keepOnDifferent = {
      verdict: 'DIFFERENT_PEOPLE',
      keepEmployeeId: openCollision?.employee.id,
      note: 'Brothers.',
    } as unknown as ResolveCollisionRequest;
    const wrongShape = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: keepOnDifferent,
    });
    expect(wrongShape.error?.errors?.[0]?.path).toBe('keepEmployeeId');

    // The new record is the real person, so the older record is the duplicate.
    const decided = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: {
        verdict: 'SAME_PERSON',
        keepEmployeeId: openCollision?.employee.id ?? '',
        note: "The older record used this worker's face.",
      },
    });
    expect(decided.data?.resolution?.keptEmployeeId).toBe(openCollision?.employee.id);
    const older = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: openCollision?.lookedLike.id ?? '' } },
    });
    expect(older.data?.face.status).toBe('BLOCKED');
    expect(older.data?.passkeys.every((key) => key.revokedAt !== null)).toBe(true);

    const again = await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      ...path,
      body: { verdict: 'DIFFERENT_PEOPLE', note: 'Changed my mind.' },
    });
    expect(again.response.status).toBe(409);
  });

  it('needs a second ADMIN to decide an exemption', async () => {
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

  it('lets a second ADMIN approve an exemption', async () => {
    await signInForTests('admin@samtec.example');
    const refuser = mockBiometrics.find((row) => row.exemption?.status === 'REQUESTED');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometric-exemption/review', {
      params: { path: { employeeId: refuser?.employeeId ?? '' } },
      body: { decision: 'APPROVE', note: 'Ghana Card checked in person.' },
    });
    expect(data?.exemption).toMatchObject({
      status: 'APPROVED',
      reviewedByUserId: expect.any(String),
    });
  });

  it('refuses an exemption while a duplicate review is open, or for a blocked record', async () => {
    await signInForTests('admin@samtec.example');
    const ask = () =>
      fetchClient.POST('/employees/{employeeId}/biometric-exemption', {
        params: { path: { employeeId: openCollision?.employee.id ?? '' } },
        body: { reason: 'DECLINED', note: 'Would skip the duplicate check.' },
      });
    expect((await ask()).response.status).toBe(409);

    // The older record is the real person, so this record is blocked for good.
    await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: {
        verdict: 'SAME_PERSON',
        keepEmployeeId: openCollision?.lookedLike.id ?? '',
        note: 'One person enrolled twice.',
      },
    });
    expect((await ask()).response.status).toBe(409);
  });

  it('keeps a duplicate blocked for good, whatever happens next', async () => {
    await signInForTests('admin@samtec.example');
    const employeeId = openCollision?.employee.id ?? '';
    await fetchClient.POST('/biometric-collisions/{credentialId}/resolve', {
      params: { path: { credentialId: openCollision?.credentialId ?? '' } },
      body: {
        verdict: 'SAME_PERSON',
        keepEmployeeId: openCollision?.lookedLike.id ?? '',
        note: 'One person enrolled twice.',
      },
    });
    const path = { params: { path: { employeeId } } };
    const revoke = await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      ...path,
      body: { reason: 'Trying to clear the block.' },
    });
    expect(revoke.response.status).toBe(409);

    const withdrawn = await fetchClient.POST(
      '/employees/{employeeId}/biometric-consents/withdraw',
      {
        ...path,
        body: { reason: 'Trying to clear the block.' },
      },
    );
    expect(withdrawn.data?.face.status).toBe('BLOCKED');

    const asked = await fetchClient.POST('/employees/{employeeId}/biometric-exemption', {
      ...path,
      body: { reason: 'DECLINED', note: 'Trying to clear the block.' },
    });
    expect(asked.response.status).toBe(409);
  });

  it('ends an exemption when the worker is revoked, so it needs two ADMINs again', async () => {
    await signInForTests('admin@samtec.example');
    const exempt = mockBiometrics.find((row) => row.exemption?.status === 'APPROVED');
    const { data } = await fetchClient.POST('/employees/{employeeId}/biometrics/revoke', {
      params: { path: { employeeId: exempt?.employeeId ?? '' } },
      body: { reason: 'Cleaning up the record.' },
    });
    expect(data?.exemption?.status).toBe('ENDED');
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
