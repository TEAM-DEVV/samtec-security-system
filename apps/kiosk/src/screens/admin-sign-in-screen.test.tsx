import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSignInScreen } from './admin-sign-in-screen';

/**
 * An administrator signing in at the kiosk.
 *
 * The server decides that this is a *kiosk* sign-in from the browser's `Origin`
 * header, and it is the server that refuses every role but ADMIN — none of that
 * can be tested here, and none of it should be enforced twice. What this screen
 * owes is narrower: never offer two-factor **set-up** on a screen in a public
 * place, never keep the password after it is spent, and never tell a stranger
 * which email addresses exist.
 */
let answers: { status: number; body: unknown }[] = [];
let sent: { url: string; body: string }[] = [];

const SESSION = {
  status: 'AUTHENTICATED',
  accessToken: 'kiosk-token',
  expiresInSeconds: 900,
  user: {
    id: '01927c3e-aaaa-7000-8000-000000000001',
    email: 'admin@samtec.example',
    fullName: 'Ama Boateng',
    role: 'ADMIN',
    twoFactorEnabled: true,
    employeeId: null,
  },
};

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body ?? '') });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error(`Unexpected request to ${url}`);
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
});

async function signInWith(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'admin@samtec.example');
  await user.type(screen.getByLabelText('Password'), 'demo-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('AdminSignInScreen', () => {
  it('signs in when no code is needed', async () => {
    answers = [{ status: 200, body: SESSION }];
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={onSignedIn} onCancel={vi.fn()} />);

    await signInWith(user);

    expect(onSignedIn).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'kiosk-token', fullName: 'Ama Boateng' }),
    );
  });

  it('asks for the six-digit code, then signs in', async () => {
    answers = [
      {
        status: 200,
        body: {
          status: 'TWO_FACTOR_REQUIRED',
          challengeToken: 'k.challenge',
          expiresInSeconds: 300,
        },
      },
      { status: 200, body: SESSION },
    ];
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={onSignedIn} onCancel={vi.fn()} />);

    await signInWith(user);
    await user.type(await screen.findByLabelText('Six-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onSignedIn).toHaveBeenCalled();
    // The challenge token goes back exactly as it came.
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      challengeToken: 'k.challenge',
      code: '123456',
    });
  });

  it('keeps the password no longer than it takes to spend it', async () => {
    answers = [
      {
        status: 200,
        body: {
          status: 'TWO_FACTOR_REQUIRED',
          challengeToken: 'k.challenge',
          expiresInSeconds: 300,
        },
      },
    ];
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={vi.fn()} onCancel={vi.fn()} />);

    await signInWith(user);
    await screen.findByLabelText('Six-digit code');

    // The password box is gone with the form that held it, and nothing carried
    // the value forward. This is a phone on a wall.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('demo-password')).not.toBeInTheDocument();
  });

  it('refuses to set up two-factor on a screen in a public place', async () => {
    answers = [
      {
        status: 200,
        body: { status: 'TWO_FACTOR_SETUP_REQUIRED', setupToken: 'x', otpauthUri: 'otpauth://x' },
      },
    ];
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={vi.fn()} onCancel={vi.fn()} />);

    await signInWith(user);

    // Setting it up means showing a QR code and a secret key on a wall.
    expect(await screen.findByRole('alert')).toHaveTextContent(/on the dashboard first/);
    // And no QR code or key reached the screen.
    expect(document.body.textContent).not.toMatch(/otpauth/);
  });

  it('only takes digits in the code box', async () => {
    answers = [
      {
        status: 200,
        body: {
          status: 'TWO_FACTOR_REQUIRED',
          challengeToken: 'k.challenge',
          expiresInSeconds: 300,
        },
      },
    ];
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={vi.fn()} onCancel={vi.fn()} />);
    await signInWith(user);

    const box = await screen.findByLabelText<HTMLInputElement>('Six-digit code');
    await user.type(box, '12ab34');
    expect(box.value).toBe('1234');
  });

  it('shows the server’s refusal, which never says whether the email exists', async () => {
    answers = [
      {
        status: 401,
        body: {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'That email and password do not match.',
          traceId: 'trace-3',
        },
      },
    ];
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={vi.fn()} onCancel={vi.fn()} />);

    await signInWith(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/);
    expect(document.body.textContent).not.toMatch(/no account|not found|unknown user/i);
  });

  it('shows a notice it was opened with, such as a session that ran out', async () => {
    render(
      <AdminSignInScreen
        onSignedIn={vi.fn()}
        onCancel={vi.fn()}
        initialNotice="Your session ended after fifteen minutes. Sign in again."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your session ended after fifteen minutes. Sign in again.',
    );
  });

  it('goes back without signing in', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<AdminSignInScreen onSignedIn={vi.fn()} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onCancel).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
