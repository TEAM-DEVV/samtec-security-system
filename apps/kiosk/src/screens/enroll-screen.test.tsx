import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSession } from '@/lib/admin-session';
import type { PairedDevice } from '@/lib/device';
import { MockFaceEngine } from '@/lib/face-mock';
import { importSigningKey } from '@/lib/signing';
import { EnrollScreen, type Task } from './enroll-screen';

// The sensor is pretended; the availability check says yes so the buttons show.
vi.mock('@/lib/passkeys', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/passkeys')>();
  return { ...real, createPasskey: vi.fn(), passkeysAvailable: () => true };
});
const passkeys = vi.mocked(await import('@/lib/passkeys'));

/**
 * Putting a worker on the system.
 *
 * Nothing here is about whether a face matches — that is the server's job and
 * the real models'. These tests are about the two promises this screen makes:
 * that the consent words shown are the server's exact words, and that a
 * collision never names the person the face looked like.
 */
const CONSENT_TEXT = {
  version: 'bio-v1',
  text: 'SAMTEC will store a mathematical description of your face.\nIt is never a photograph.\nYou may withdraw at any time.',
  sha256: 'a'.repeat(64),
};

const WAITING = {
  items: [
    {
      id: '01927c3e-5a4b-7c8d-9e0f-000000000002',
      staffNumber: 'SMT-00002',
      fullName: 'Abena Owusu',
      position: 'Senior Guard',
      status: 'PENDING_ENROLLMENT',
      biometricEnrolledAt: null,
      currentSite: null,
      hireDate: '2026-09-01',
    },
  ],
  nextCursor: null,
};

const CONSENT_RECORDED = {
  id: '01927c3e-cccc-7000-8000-000000000001',
  employeeId: WAITING.items[0]?.id,
  status: 'GIVEN',
  textVersion: 'bio-v1',
  textSha256: 'a'.repeat(64),
  recordedAt: '2026-09-27T09:00:00.000Z',
  recordedByUserId: '01927c3e-aaaa-7000-8000-000000000001',
  deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
};

/** What the pretend server answers, by the route in the URL. */
let answers: Record<string, { status: number; body: unknown }> = {};
let sent: { url: string; headers: Record<string, string>; body: string }[] = [];

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-27T06:00:00.000Z',
  };
}

const ADMIN: AdminSession = {
  accessToken: 'test-admin-token',
  fullName: 'Ama Boateng',
  expiresAt: Date.now() + 900_000,
};

beforeEach(() => {
  sent = [];
  answers = {
    '/biometrics/consent-text': { status: 200, body: CONSENT_TEXT },
    '/employees': { status: 200, body: WAITING },
    '/kiosk/consents': { status: 200, body: CONSENT_RECORDED },
    '/kiosk/face-enrollments': {
      status: 200,
      body: {
        credentialId: '01927c3e-dddd-7000-8000-000000000001',
        dedupe: 'PASSED',
        employeeStatus: 'ACTIVE',
      },
    },
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body ?? ''),
    });
    const match = Object.keys(answers).find((path) => url.includes(path));
    if (match === undefined) {
      throw new Error(`Unexpected request to ${url}`);
    }
    const answer = answers[match];
    return Promise.resolve(
      new Response(JSON.stringify(answer?.body), {
        status: answer?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderScreen(onDone = vi.fn(), initialTask: Task = 'enroll') {
  const device = await aPairedKiosk();
  render(
    <EnrollScreen
      device={device}
      admin={ADMIN}
      engine={new MockFaceEngine()}
      onDone={onDone}
      initialTask={initialTask}
      // No real half-second waits, and a short challenge.
      betweenCaptures={1}
      challengeSeconds={2}
    />,
  );
  return onDone;
}

/** Picks the waiting worker and moves to the consent step. */
async function reachConsent(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('option', { name: /Abena Owusu/ });
  await user.selectOptions(screen.getByLabelText('Worker'), WAITING.items[0]?.id ?? '');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('EnrollScreen', () => {
  it('lists only the people still waiting to be enrolled', async () => {
    await renderScreen();
    expect(
      await screen.findByRole('option', { name: /SMT-00002 · Abena Owusu/ }),
    ).toBeInTheDocument();
    // The request asks the server for exactly those, rather than filtering here.
    await waitFor(() =>
      expect(sent.some((one) => one.url.includes('status=PENDING_ENROLLMENT'))).toBe(true),
    );
  });

  it('shows the consent words exactly as the server sent them', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);

    // Every line, unparaphrased. The record says which version was agreed to, so
    // the words on screen have to be those words.
    for (const line of CONSENT_TEXT.text.split('\n')) {
      expect(screen.getByText(new RegExp(line.slice(0, 30)))).toBeInTheDocument();
    }
    expect(screen.getByText('bio-v1')).toBeInTheDocument();
  });

  it('records nothing until the worker has agreed', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);

    await user.type(screen.getByLabelText(/Last 4 digits/), '1234');
    await user.click(screen.getByRole('button', { name: /Record consent/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/has to agree/);
    expect(sent.some((one) => one.url.includes('/kiosk/consents'))).toBe(false);
  });

  it('asks for the card digits before recording anything', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/last four digits/);
    expect(sent.some((one) => one.url.includes('/kiosk/consents'))).toBe(false);
  });

  it('records the consent, takes three faces and enrols', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);

    await user.type(screen.getByLabelText(/Last 4 digits/), '1234');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));

    expect(
      await screen.findByRole('heading', { name: 'Enrolled' }, { timeout: 12_000 }),
    ).toBeInTheDocument();

    const enrollment = sent.find((one) => one.url.includes('/kiosk/face-enrollments'));
    expect(enrollment).toBeDefined();
    const body = JSON.parse(enrollment?.body ?? '{}');
    // Exactly three, as the contract requires, and each a full template.
    expect(body.samples).toHaveLength(3);
    for (const sample of body.samples) {
      expect(sample.embedding).toHaveLength(1024);
      expect(sample.model).toBe('human-faceres-1');
    }
    expect(body.consentId).toBe(CONSENT_RECORDED.id);
  });

  it('carries both the administrator’s token and the device signature', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);
    await user.type(screen.getByLabelText(/Last 4 digits/), '1234');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));
    await screen.findByRole('heading', { name: 'Enrolled' }, { timeout: 12_000 });

    // A stolen password cannot enrol anybody, and neither can a stolen kiosk.
    for (const path of ['/kiosk/consents', '/kiosk/face-enrollments']) {
      const request = sent.find((one) => one.url.includes(path));
      expect(request?.headers.Authorization).toBe('Bearer test-admin-token');
      expect(request?.headers['X-Samtec-Signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(request?.headers['X-Samtec-Device']).toBe('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01');
    }
  });

  it('says only that a collision needs a review, and never who it looked like', async () => {
    answers['/kiosk/face-enrollments'] = {
      status: 200,
      body: {
        credentialId: '01927c3e-dddd-7000-8000-000000000002',
        dedupe: 'COLLISION',
        employeeStatus: 'PENDING_ENROLLMENT',
      },
    };
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);
    await user.type(screen.getByLabelText(/Last 4 digits/), '1234');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));

    expect(
      await screen.findByRole('heading', { name: 'Needs an admin review' }, { timeout: 12_000 }),
    ).toBeInTheDocument();
    // Saying a face "looks like someone already enrolled" is fine — it never
    // names who. Naming the match would tell whoever is standing here who
    // else works for this company, and nor may a score appear.
    expect(screen.getByText(/This face looks like someone already enrolled/)).toBeInTheDocument();
    const shown = document.body.textContent ?? '';
    expect(shown).not.toMatch(/COLLISION/);
    expect(shown).not.toMatch(/0\.\d\d/);
    expect(shown).not.toMatch(/similar|confiden/i);
  });

  it('forgets the card digits once the consent is recorded', async () => {
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);
    await user.type(screen.getByLabelText(/Last 4 digits/), '1234');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));
    await screen.findByRole('heading', { name: 'Enrolled' }, { timeout: 12_000 });

    // Part of somebody's Ghana Card number must not sit in a kiosk's memory
    // after it has done its job.
    await user.click(screen.getByRole('button', { name: 'Enrol somebody else' }));
    expect(screen.queryByDisplayValue('1234')).not.toBeInTheDocument();
  });

  it('shows the server’s own refusal rather than inventing one', async () => {
    answers['/kiosk/consents'] = {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Those are not the last four digits of this worker’s Ghana Card.',
        traceId: 'trace-9',
      },
    };
    const user = userEvent.setup();
    await renderScreen();
    await reachConsent(user);
    await user.type(screen.getByLabelText(/Last 4 digits/), '9999');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Record consent/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not the last four digits/);
    // And nothing was captured: consent comes first, always.
    expect(sent.some((one) => one.url.includes('/kiosk/face-enrollments'))).toBe(false);
  });
});

/**
 * Saving a worker's fingerprint on this phone.
 *
 * The sensor is pretended (`@/lib/passkeys` is mocked): a test runner has no
 * finger. What is real: the server's options go to the sensor unchanged, the
 * sealed ticket goes back unchanged, and only the sensor's public answer is
 * ever sent — never anything read from a finger.
 */
describe('EnrollScreen · saving a fingerprint', () => {
  it('opens straight on the fingerprint task when the menu preselects it', async () => {
    await renderScreen(vi.fn(), 'finger');

    // The admin menu's own "Save a fingerprint" item promoted this from a
    // toggle a few taps in, to the screen an administrator lands on directly.
    expect(await screen.findByRole('heading', { name: 'Whose fingerprint?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to enrolling a face' })).toBeInTheDocument();
  });

  it('offers it for an enrolled worker, and registers the key the sensor made', async () => {
    answers['/kiosk/passkey-options'] = {
      status: 200,
      body: { ticket: 'sealed-ticket', options: { challenge: 'from-the-server' } },
    };
    answers['/kiosk/passkeys'] = {
      status: 201,
      body: {
        id: '01927c3e-eeee-7000-8000-000000000001',
        deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
        deviceName: 'Main Gate kiosk',
        registeredAt: '2026-09-29T09:00:00.000Z',
        synced: true,
        revokedAt: null,
      },
    };
    const registration = { id: 'new-key', rawId: 'new-key', type: 'public-key' };
    passkeys.createPasskey.mockResolvedValue(
      registration as unknown as Awaited<ReturnType<typeof passkeys.createPasskey>>,
    );
    const user = userEvent.setup();
    await renderScreen();

    await user.click(
      await screen.findByRole('button', { name: 'Save a fingerprint instead (already enrolled)' }),
    );
    await user.selectOptions(screen.getByLabelText('Worker'), 'SMT-00002 · Abena Owusu');
    await user.click(screen.getByRole('button', { name: 'Save their fingerprint' }));

    expect(await screen.findByRole('heading', { name: 'Fingerprint saved' })).toBeInTheDocument();
    // The server's options reached the sensor unchanged…
    expect(passkeys.createPasskey).toHaveBeenCalledWith({ challenge: 'from-the-server' });
    // …and the registration went back with the sealed ticket, unchanged.
    const registered = sent.find((request) => request.url.includes('/kiosk/passkeys'));
    expect(JSON.parse(registered?.body ?? '{}')).toEqual({
      employeeId: '01927c3e-5a4b-7c8d-9e0f-000000000002',
      ticket: 'sealed-ticket',
      response: registration,
    });
    // A synced key is called out for the records, as the contract asks.
    expect(screen.getByText(/copy the key to its own cloud account/)).toBeInTheDocument();
  });
});
