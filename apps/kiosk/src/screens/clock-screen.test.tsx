import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { MockFaceEngine } from '@/lib/face-mock';
import { type AssertionJson, FingerprintRefused } from '@/lib/passkeys';
import { importSigningKey } from '@/lib/signing';
import { ClockScreen } from './clock-screen';

// The sensor is pretended: a test runner has no finger. The class and the
// option-crossing helpers stay real, so the screen's error handling is the
// shipped one.
vi.mock('@/lib/passkeys', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/passkeys')>();
  return { ...real, getAssertion: vi.fn(), createPasskey: vi.fn() };
});
const passkeys = vi.mocked(await import('@/lib/passkeys'));

/**
 * The everyday screen.
 *
 * The camera is pretended (`MockFaceEngine`) and so is the server, because a
 * real one of either would need a face, 10 MB of models and a running API — and
 * would answer slightly differently every run. What is real: every threshold,
 * the head-turn challenge, the request bodies and the signature headers.
 *
 * A pretend head that *never turns* is how the photograph case is tested: that
 * is exactly what a printed photograph does.
 */

/** Whatever the pretend server should answer next, in order. */
let answers: { status: number; body: unknown }[] = [];
/** Every request the screen made, so the test can check what was sent. */
let sent: { url: string; headers: Record<string, string>; body: string }[] = [];

async function aPairedKiosk(): Promise<PairedDevice> {
  return {
    deviceId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
    name: 'Main Gate kiosk',
    key: await importSigningKey('sk_test_only_not_a_real_device_secret'),
    pairedAt: '2026-09-26T06:00:00.000Z',
  };
}

const MATCHED = {
  status: 200,
  body: {
    attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c02',
    outcome: 'MATCHED',
    worker: { displayName: 'Kwame A.', staffNumber: 'SMT-00042' },
    fingerprint: null,
  },
};

const NOT_RECOGNISED = {
  status: 200,
  body: {
    attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c03',
    outcome: 'NOT_RECOGNISED',
    worker: null,
    fingerprint: null,
  },
};

const PUNCHED = {
  status: 200,
  body: {
    punchId: '01927c3e-3333-7aaa-8bbb-0c0c0c0c0c04',
    status: 'ACCEPTED',
    method: 'FACE',
    direction: 'IN',
    recordedAt: '2026-09-26T06:01:00.000Z',
    worker: { displayName: 'Kwame A.', staffNumber: 'SMT-00042' },
  },
};

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error(`The screen made an unexpected request to ${url}`);
    }
    return Promise.resolve(
      new Response(next.status === 204 ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders the screen with a pretend camera whose head follows instructions. */
async function renderScreen(engine = new MockFaceEngine(), showTheNameFor = 10) {
  const device = await aPairedKiosk();
  render(
    <ClockScreen
      device={device}
      engine={engine}
      // 10ms rather than two seconds by default, so a test does not wait for the
      // greeting. The "Not me" test asks for longer, because it has to get a
      // click in before the punch goes through on its own.
      showTheNameFor={showTheNameFor}
      // One second rather than twenty, so the refusal case is not a 20s test.
      challengeSeconds={1}
    />,
  );
  return engine;
}

describe('ClockScreen', () => {
  it('records a shift start: turn your head, see your name, punch goes in', async () => {
    answers = [MATCHED, PUNCHED];
    const user = userEvent.setup();
    await renderScreen();

    expect(screen.getByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    expect(await screen.findByText('Hello, Kwame A.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Shift started' })).toBeInTheDocument();
    expect(screen.getByText(/Recorded for Kwame A\./)).toBeInTheDocument();
  });

  it('signs every request, and sends exactly the body it signed', async () => {
    answers = [MATCHED, PUNCHED];
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await screen.findByRole('heading', { name: 'Shift started' });

    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.headers['X-Samtec-Device']).toBe('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01');
      expect(request.headers['X-Samtec-Signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(request.headers['X-Samtec-Timestamp']).toMatch(/^\d+$/);
    }
    // The route name is in the URL, and it is the same name that was signed.
    expect(sent[0]?.url).toContain('/kiosk/identify');
    expect(sent[1]?.url).toContain('/kiosk/confirm');
    // The identify body carries the sample and the direction, and nothing else.
    const body = JSON.parse(sent[0]?.body ?? '{}');
    expect(Object.keys(body).sort()).toEqual(['direction', 'purpose', 'sample']);
    expect(body.purpose).toBe('CLOCK');
    expect(body.direction).toBe('IN');
    expect(body.sample.embedding).toHaveLength(1024);
  });

  it('refuses a printed photograph, because it cannot turn its head', async () => {
    const user = userEvent.setup();
    // A head that never turns. The challenge runs out and nothing is sent.
    await renderScreen(new MockFaceEngine({ head: 'still' }));
    await user.click(screen.getByRole('button', { name: 'End shift' }));

    // A still head keeps the instruction on screen, which is also the only place
    // the challenge wording can be observed — a head that follows performs the
    // whole gesture in a couple of frames.
    expect(await screen.findByText(/Turn your head to the (left|right)/)).toBeInTheDocument();

    expect(
      await screen.findByText(/Stand square to the screen and try again/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Nothing reached the server: a photograph never gets that far.
    expect(sent).toHaveLength(0);
  });

  it('never says why a face was not recognised, and never shows a score', async () => {
    answers = [NOT_RECOGNISED];
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    expect(await screen.findByText('Not recognised. Please try again.')).toBeInTheDocument();
    // Anybody can stand in front of a kiosk, so nothing here may hint at who
    // the face nearly matched, or how close it was.
    const shown = document.body.textContent ?? '';
    expect(shown).not.toMatch(/NOT_RECOGNISED|AMBIGUOUS|LOW_LIVENESS/);
    expect(shown).not.toMatch(/0\.\d\d/);
    expect(shown).not.toMatch(/score|match|confiden/i);
  });

  it('offers the fallbacks only after three failures in a row', async () => {
    answers = [NOT_RECOGNISED, NOT_RECOGNISED, NOT_RECOGNISED];
    const user = userEvent.setup();
    await renderScreen();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // After a refusal the screen offers "Start again", which returns it to
      // Ready — the shift button is the next press, not the same one.
      if (attempt > 1) {
        await user.click(screen.getByRole('button', { name: 'Start again' }));
      }
      await user.click(screen.getByRole('button', { name: 'Start shift' }));
      await screen.findByText('Not recognised. Please try again.');

      // Every call spends the unlock whatever the answer, so the fallback is
      // offered only once the face path has clearly failed.
      if (attempt < 3) {
        expect(screen.queryByRole('button', { name: 'Another way in' })).not.toBeInTheDocument();
      }
    }
    expect(await screen.findByRole('button', { name: 'Another way in' })).toBeInTheDocument();
  });

  it('opens the fallback screen with the direction that failed', async () => {
    answers = [NOT_RECOGNISED, NOT_RECOGNISED, NOT_RECOGNISED];
    const user = userEvent.setup();
    await renderScreen();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        await user.click(screen.getByRole('button', { name: 'Start again' }));
      }
      await user.click(screen.getByRole('button', { name: 'End shift' }));
      await screen.findByText('Not recognised. Please try again.');
    }

    await user.click(screen.getByRole('button', { name: 'Another way in' }));
    expect(await screen.findByRole('heading', { name: 'Another way in' })).toBeInTheDocument();
    // The two ways in, and nothing that leaks who works here.
    expect(
      screen.getByRole('button', { name: 'My staff number and my fingerprint' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'A supervisor clocks me in' })).toBeInTheDocument();
  });

  it('cancels the match when the worker presses Not me', async () => {
    answers = [MATCHED, { status: 204, body: null }];
    const user = userEvent.setup();
    // Two whole seconds, as the real screen gives: the wait is the only reason
    // "Not me" can be pressed at all, so the test has to use the real one.
    await renderScreen(new MockFaceEngine(), 2000);
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    await user.click(await screen.findByRole('button', { name: 'Not me' }));

    await waitFor(() => expect(sent[1]?.url).toContain('/kiosk/not-me'));
    // No punch was recorded, and it counts as a failed attempt.
    expect(sent.some((request) => request.url.includes('/kiosk/confirm'))).toBe(false);
    expect(await screen.findByText('Sorry about that. Please try again.')).toBeInTheDocument();
  });

  it('tells an administrator what to check when the server refuses this phone', async () => {
    answers = [
      {
        status: 401,
        body: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'This kiosk has been switched off.',
          traceId: 'trace-1',
        },
      },
    ];
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    // The server's one sentence for every device failure is not repeated: the
    // kiosk names what an administrator can check instead.
    expect(await screen.findByText(/refused this kiosk/)).toBeInTheDocument();
  });

  it('says a repeat was already recorded rather than pretending it is new', async () => {
    answers = [MATCHED, { status: 200, body: { ...PUNCHED.body, status: 'DUPLICATE' } }];
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    expect(await screen.findByText(/already recorded/)).toBeInTheDocument();
  });

  it('shows the device name plainly, with the Admin button separate and hidden mid-attempt', async () => {
    const user = userEvent.setup();
    const device = await aPairedKiosk();
    render(
      <ClockScreen
        device={device}
        engine={new MockFaceEngine({ head: 'still' })}
        onAdmin={vi.fn()}
        challengeSeconds={1}
      />,
    );

    // Two separate things, neither one a guess: the name is never a button,
    // and the admin door is never labelled with the kiosk's name.
    expect(screen.getByText('Main Gate kiosk')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'End shift' }));
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
    // The name itself stays up, mid-attempt as always.
    expect(screen.getByText('Main Gate kiosk')).toBeInTheDocument();

    // Back on Ready, the button returns.
    await user.click(await screen.findByRole('button', { name: 'Start again' }, { timeout: 5000 }));
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});

/**
 * A worker who has a fingerprint saved on this kiosk (`FACE_PASSKEY`).
 *
 * The sensor itself is pretended (`@/lib/passkeys` is mocked), because a test
 * runner has no finger. What is real: the server's options are handed over
 * unchanged, the punch carries the sensor's answer unchanged, and a finger
 * that fails never lets a confirmation through without one.
 */
describe('ClockScreen and a saved fingerprint', () => {
  const MATCHED_NEEDS_FINGER = {
    status: 200,
    body: {
      attemptId: '01927c3e-2222-7aaa-8bbb-0c0c0c0c0c05',
      outcome: 'MATCHED',
      worker: { displayName: 'Akua B.', staffNumber: 'SMT-00043' },
      fingerprint: { options: { challenge: 'not-a-real-challenge' } },
    },
  };
  const AN_ASSERTION = { id: 'key-1', rawId: 'key-1', type: 'public-key' } as AssertionJson;

  afterEach(() => {
    passkeys.getAssertion.mockReset();
  });

  it('asks the sensor, and confirms with its answer', async () => {
    answers = [MATCHED_NEEDS_FINGER, PUNCHED];
    // A sensor that waits for the test to press the finger, so the screen in
    // between — the name and the ask — can actually be seen.
    let pressTheFinger: (assertion: AssertionJson) => void = () => {};
    passkeys.getAssertion.mockImplementation(
      () =>
        new Promise((resolve) => {
          pressTheFinger = resolve;
        }) as ReturnType<typeof passkeys.getAssertion>,
    );
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    // The name and the ask, together: the finger press is the confirmation, so
    // there is no silent two-second timer on this path.
    expect(await screen.findByText('Hello, Akua B.')).toBeInTheDocument();
    expect(screen.getByText(/Touch the fingerprint sensor/)).toBeInTheDocument();

    pressTheFinger(AN_ASSERTION);
    expect(await screen.findByRole('heading', { name: 'Shift started' })).toBeInTheDocument();

    // The server's options went to the sensor unchanged, and the sensor's
    // answer went back unchanged.
    expect(passkeys.getAssertion).toHaveBeenCalledWith({ challenge: 'not-a-real-challenge' });
    const confirmBody = JSON.parse(sent[1]?.body ?? '{}');
    expect(sent[1]?.url).toContain('/kiosk/confirm');
    expect(confirmBody.assertion).toEqual(AN_ASSERTION);
  });

  it('never confirms when the finger was not read', async () => {
    answers = [MATCHED_NEEDS_FINGER];
    passkeys.getAssertion.mockRejectedValue(
      new FingerprintRefused('The fingerprint was not read. Try again.', true),
    );
    const user = userEvent.setup();
    await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    expect(await screen.findByText('The fingerprint was not read. Try again.')).toBeInTheDocument();
    // One request only. Confirming without the finger would be working around a
    // second factor, and the server refuses it anyway.
    expect(sent).toHaveLength(1);
    expect(sent.some((request) => request.url.includes('/kiosk/confirm'))).toBe(false);
  });
});
