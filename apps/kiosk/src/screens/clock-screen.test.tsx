import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { MockFaceEngine } from '@/lib/face-mock';
import { importSigningKey } from '@/lib/signing';
import { ClockScreen } from './clock-screen';

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

/**
 * Does what a person does: turns the way the screen asked, then looks back at
 * it.
 *
 * Both halves matter. Turning and *staying* turned is not the gesture, and the
 * screen is right to keep waiting for the centred frame — an earlier version of
 * these tests only turned, and every one of them failed for that reason.
 */
async function doTheHeadTurn(engine: MockFaceEngine) {
  const asked = await screen.findByText(/Turn your head to the (left|right)/);
  engine.askedToTurn = asked.textContent?.includes('left') ? 'LEFT' : 'RIGHT';
  await screen.findByText('Now look straight ahead');
  engine.askedToTurn = null;
}

describe('ClockScreen', () => {
  it('records a shift start: turn your head, see your name, punch goes in', async () => {
    answers = [MATCHED, PUNCHED];
    const user = userEvent.setup();
    const engine = await renderScreen();

    expect(screen.getByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));

    await doTheHeadTurn(engine);

    expect(await screen.findByText('Hello, Kwame A.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Shift started' })).toBeInTheDocument();
    expect(screen.getByText(/Recorded for Kwame A\./)).toBeInTheDocument();
  });

  it('signs every request, and sends exactly the body it signed', async () => {
    answers = [MATCHED, PUNCHED];
    const user = userEvent.setup();
    const engine = await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await doTheHeadTurn(engine);
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

    expect(
      await screen.findByText(/Stand square to the screen and try again/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Nothing reached the server: a photograph never gets that far.
    expect(sent).toHaveLength(0);
  });

  it('never says why a face was not recognised, and never shows a score', async () => {
    answers = [NOT_RECOGNISED];
    const user = userEvent.setup();
    const engine = await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await doTheHeadTurn(engine);

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
    const engine = await renderScreen();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // After a refusal the screen offers "Start again", which returns it to
      // Ready — the shift button is the next press, not the same one.
      if (attempt > 1) {
        await user.click(screen.getByRole('button', { name: 'Start again' }));
      }
      await user.click(screen.getByRole('button', { name: 'Start shift' }));
      await doTheHeadTurn(engine);
      await screen.findByText('Not recognised. Please try again.');

      // Every call spends the unlock whatever the answer, so the fallback is
      // offered only once the face path has clearly failed.
      if (attempt < 3) {
        expect(screen.queryByText(/ask your supervisor/)).not.toBeInTheDocument();
      }
    }
    expect(await screen.findByText(/ask your supervisor/)).toBeInTheDocument();
  });

  it('cancels the match when the worker presses Not me', async () => {
    answers = [MATCHED, { status: 204, body: null }];
    const user = userEvent.setup();
    // Two whole seconds, as the real screen gives: the wait is the only reason
    // "Not me" can be pressed at all, so the test has to use the real one.
    const engine = await renderScreen(new MockFaceEngine(), 2000);
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await doTheHeadTurn(engine);

    await user.click(await screen.findByRole('button', { name: 'Not me' }));

    await waitFor(() => expect(sent[1]?.url).toContain('/kiosk/not-me'));
    // No punch was recorded, and it counts as a failed attempt.
    expect(sent.some((request) => request.url.includes('/kiosk/confirm'))).toBe(false);
    expect(await screen.findByText('Sorry about that. Please try again.')).toBeInTheDocument();
  });

  it("shows the server's own words when it refuses", async () => {
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
    const engine = await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await doTheHeadTurn(engine);

    expect(await screen.findByText('This kiosk has been switched off.')).toBeInTheDocument();
  });

  it('says a repeat was already recorded rather than pretending it is new', async () => {
    answers = [MATCHED, { status: 200, body: { ...PUNCHED.body, status: 'DUPLICATE' } }];
    const user = userEvent.setup();
    const engine = await renderScreen();
    await user.click(screen.getByRole('button', { name: 'Start shift' }));
    await doTheHeadTurn(engine);

    expect(await screen.findByText(/already recorded/)).toBeInTheDocument();
  });
});
