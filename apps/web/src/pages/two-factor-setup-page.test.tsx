import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { env } from '@/lib/env';
import { getSession, setPendingTwoFactor } from '@/lib/session';
import { MOCK_PASSWORD, MOCK_TWO_FACTOR_CODE } from '@/mocks/data/users';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { TwoFactorSetupPage } from './two-factor-setup-page';

function renderSetupPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.twoFactorSetup} element={<TwoFactorSetupPage />} />
      <Route path={routes.login} element={<p>Sign-in page</p>} />
      <Route path={routes.home} element={<p>Dashboard home</p>} />
    </Routes>,
    { route: routes.twoFactorSetup },
  );
}

/** Does the password step for the HR account, which must set up two-factor first. */
async function signInAsHr() {
  const login = await fetchClient.POST('/auth/login', {
    body: { email: 'hr@samtec.example', password: MOCK_PASSWORD },
  });
  if (login.data?.status !== 'TWO_FACTOR_SETUP_REQUIRED') {
    throw new Error('Expected a request to set up two-factor authentication');
  }
  setPendingTwoFactor({ step: 'SETUP', setupToken: login.data.setupToken });
}

describe('TwoFactorSetupPage', () => {
  it('sends the user back to sign in when there is no pending setup', async () => {
    renderSetupPage();

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('shows the QR code and the manual key', async () => {
    await signInAsHr();
    renderSetupPage();

    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByText('MOCKSECRETMOCKSECRET')).toBeInTheDocument();
  });

  it('turns two-factor on with the first code and signs the user in', async () => {
    await signInAsHr();
    renderSetupPage();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('6-digit code'), MOCK_TWO_FACTOR_CODE);
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }));

    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
    expect(getSession()?.user.twoFactorEnabled).toBe(true);
  });

  it('shows the API message for a wrong code', async () => {
    await signInAsHr();
    renderSetupPage();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }));

    expect(await screen.findByText('The code is incorrect.')).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it('explains a server error and shows the QR code after "Try again"', async () => {
    // Fail only the first request; the mock's normal answer serves the retry.
    server.use(
      http.post(
        `${env.apiBaseUrl}/auth/2fa/setup`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              detail: 'The database is not available.',
              traceId: 'trace-test-2fa',
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    await signInAsHr();
    renderSetupPage();

    expect(await screen.findByText('The database is not available.')).toBeInTheDocument();
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
  });

  it('sends a user who is mid-verification to the code screen instead', async () => {
    setPendingTwoFactor({ step: 'VERIFY', challengeToken: 'mock-verify-token.any' });
    renderWithProviders(
      <Routes>
        <Route path={routes.twoFactorSetup} element={<TwoFactorSetupPage />} />
        <Route path={routes.twoFactorVerify} element={<p>Code screen</p>} />
      </Routes>,
      { route: routes.twoFactorSetup },
    );

    expect(await screen.findByText('Code screen')).toBeInTheDocument();
  });

  it('offers a way back to sign in when the setup token has expired', async () => {
    setPendingTwoFactor({ step: 'SETUP', setupToken: 'mock-setup-token.expired' });
    renderSetupPage();

    expect(
      await screen.findByText('This sign-in has expired. Sign in with your password again.'),
    ).toBeInTheDocument();
    // A dead token cannot be retried, only replaced by signing in again.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('link', { name: 'Start over' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });
});
