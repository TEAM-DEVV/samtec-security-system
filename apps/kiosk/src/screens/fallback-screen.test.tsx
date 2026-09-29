import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { MockFaceEngine } from '@/lib/face-mock';
import { type AssertionJson, FingerprintRefused } from '@/lib/passkeys';
import { importSigningKey } from '@/lib/signing';
import { FallbackScreen } from './fallback-screen';

// The sensor is pretended: a test runner has no finger. Everything else — the
// requests, the signatures, the neutral wording — is the shipped code.
vi.mock('@/lib/passkeys', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/passkeys')>();
  return { ...real, getAssertion: vi.fn(), createPasskey: vi.fn() };
});
const passkeys = vi.mocked(await import('@/lib/passkeys'));

let answers: { status: number; body: unknown }[] = [];
let sent: { url: string; body: string }[] = [];

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body ?? '') });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error(`The screen made an unexpected request to ${url}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  passkeys.getAssertion.mockReset();
});

const A_WORKER = { displayName: 'Kwame A.', staffNumber: 'GA-0007' };
const AN_ASSERTION = { id: 'key-1', rawId: 'key-1', type: 'public-key' } as AssertionJson;
const PUNCHED = {
  status: 200,
  body: {
    punchId: '01927c3e-3333-7aaa-8bbb-0c0c0c0c0c04',
    status: 'ACCEPTED',
    method: 'STAFF_PASSKEY',
    direction: 'IN',
    recordedAt: '2026-09-29T06:01:00.000Z',
    worker: A_WORKER,
  },
};

async function renderFallback(onDone = vi.fn(), engine = new MockFaceEngine()) {
  const device: PairedDevice = {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-29T06:00:00.000Z',
  };
  render(
    <FallbackScreen
      device={device}
      engine={engine}
      direction="IN"
      onDone={onDone}
      onCancel={vi.fn()}
      challengeSeconds={1}
    />,
  );
  return onDone;
}

describe('FallbackScreen · staff number and fingerprint', () => {
  it('asks who they are, then the sensor, then records the punch', async () => {
    answers = [
      {
        status: 200,
        body: {
          attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c05',
          worker: A_WORKER,
          options: { challenge: 'from-the-server' },
        },
      },
      PUNCHED,
    ];
    passkeys.getAssertion.mockResolvedValue(AN_ASSERTION);
    const onDone = vi.fn();
    const user = userEvent.setup();
    await renderFallback(onDone);

    await user.click(screen.getByRole('button', { name: 'My staff number and my fingerprint' }));
    await user.type(screen.getByLabelText('Your staff number'), 'ga-0007');
    await user.click(screen.getByRole('button', { name: 'Continue to the fingerprint' }));

    // The typed number is tidied to the contract's shape before it is sent.
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ staffNumber: 'GA-0007', direction: 'IN' });
    expect(sent[0]?.url).toContain('/kiosk/fingerprint-options');

    // The server's options went to the sensor unchanged, and the punch carried
    // the sensor's answer unchanged.
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(passkeys.getAssertion).toHaveBeenCalledWith({ challenge: 'from-the-server' });
    const confirm = JSON.parse(sent[1]?.body ?? '{}');
    expect(sent[1]?.url).toContain('/kiosk/confirm');
    expect(confirm.assertion).toEqual(AN_ASSERTION);
  });

  it("shows the server's one neutral refusal, and never a reason of its own", async () => {
    answers = [
      {
        status: 409,
        body: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This way in is not available. Please see your supervisor.',
        },
      },
    ];
    const user = userEvent.setup();
    await renderFallback();

    await user.click(screen.getByRole('button', { name: 'My staff number and my fingerprint' }));
    await user.type(screen.getByLabelText('Your staff number'), 'GA-9999');
    await user.click(screen.getByRole('button', { name: 'Continue to the fingerprint' }));

    expect(
      await screen.findByText('This way in is not available. Please see your supervisor.'),
    ).toBeInTheDocument();
    // Whether a staff number exists, works here or has a key must all read the
    // same to whoever is standing at the kiosk.
    const shown = document.body.textContent ?? '';
    expect(shown).not.toMatch(/unknown|no passkey|not posted|not unlocked/i);
  });

  it('offers the finger again after a cancelled read, without a new attempt', async () => {
    answers = [
      {
        status: 200,
        body: {
          attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c05',
          worker: A_WORKER,
          options: { challenge: 'from-the-server' },
        },
      },
      PUNCHED,
    ];
    passkeys.getAssertion
      .mockRejectedValueOnce(
        new FingerprintRefused('The fingerprint was not read. Try again.', true),
      )
      .mockResolvedValueOnce(AN_ASSERTION);
    const onDone = vi.fn();
    const user = userEvent.setup();
    await renderFallback(onDone);

    await user.click(screen.getByRole('button', { name: 'My staff number and my fingerprint' }));
    await user.type(screen.getByLabelText('Your staff number'), 'GA-0007');
    await user.click(screen.getByRole('button', { name: 'Continue to the fingerprint' }));

    await user.click(await screen.findByRole('button', { name: 'Try the fingerprint again' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    // One options call, one confirm: the retry reused the same attempt.
    expect(sent.filter((request) => request.url.includes('fingerprint-options'))).toHaveLength(1);
  });
});

describe('FallbackScreen · a supervisor co-signs', () => {
  it('names the worker and the reason, proves the supervisor, and records', async () => {
    answers = [
      {
        status: 200,
        body: {
          attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c06',
          outcome: 'MATCHED',
          worker: { displayName: 'Abena O.', staffNumber: 'SV-0001' },
          fingerprint: null,
        },
      },
      { ...PUNCHED, body: { ...PUNCHED.body, method: 'PIN_FALLBACK' } },
    ];
    const onDone = vi.fn();
    const user = userEvent.setup();
    await renderFallback(onDone);

    await user.click(screen.getByRole('button', { name: 'A supervisor clocks me in' }));
    await user.type(screen.getByLabelText(/staff number/), 'GA-0007');
    await user.type(screen.getByLabelText(/Why can/), 'Face not recognised');
    await user.click(screen.getByRole('button', { name: 'Supervisor: prove your face' }));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 5000 });
    // The supervisor's identify names the worker and carries the face sample.
    const identify = JSON.parse(sent[0]?.body ?? '{}');
    expect(identify.purpose).toBe('CO_SIGN');
    expect(identify.staffNumber).toBe('GA-0007');
    expect(identify.sample.embedding).toHaveLength(1024);
    // The punch carries the co-sign attempt and the audited reason.
    const punch = JSON.parse(sent[1]?.body ?? '{}');
    expect(sent[1]?.url).toContain('/kiosk/assisted-punches');
    expect(punch).toEqual({
      coSignAttemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c06',
      reason: 'Face not recognised',
    });
  });

  it("requires the supervisor's finger when they have a key here", async () => {
    answers = [
      {
        status: 200,
        body: {
          attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c07',
          outcome: 'MATCHED',
          worker: { displayName: 'Abena O.', staffNumber: 'SV-0001' },
          fingerprint: { options: { challenge: 'supervisor-finger' } },
        },
      },
      { ...PUNCHED, body: { ...PUNCHED.body, method: 'PIN_FALLBACK' } },
    ];
    passkeys.getAssertion.mockResolvedValue(AN_ASSERTION);
    const onDone = vi.fn();
    const user = userEvent.setup();
    await renderFallback(onDone);

    await user.click(screen.getByRole('button', { name: 'A supervisor clocks me in' }));
    await user.type(screen.getByLabelText(/staff number/), 'GA-0007');
    await user.type(screen.getByLabelText(/Why can/), 'Camera cannot see in the rain');
    await user.click(screen.getByRole('button', { name: 'Supervisor: prove your face' }));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 5000 });
    expect(passkeys.getAssertion).toHaveBeenCalledWith({ challenge: 'supervisor-finger' });
    const punch = JSON.parse(sent[1]?.body ?? '{}');
    expect(punch.assertion).toEqual(AN_ASSERTION);
  });

  it('never shows a score or an outcome name on any of its screens', async () => {
    const user = userEvent.setup();
    await renderFallback();
    await user.click(screen.getByRole('button', { name: 'A supervisor clocks me in' }));
    const shown = document.body.textContent ?? '';
    expect(shown).not.toMatch(/MATCHED|AMBIGUOUS|NOT_RECOGNISED|LOW_LIVENESS/);
    expect(shown).not.toMatch(/0\.\d\d/);
    expect(shown).not.toMatch(/score|match|confiden/i);
  });
});
