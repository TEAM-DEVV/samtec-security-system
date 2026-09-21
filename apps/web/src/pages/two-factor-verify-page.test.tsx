import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { getPendingTwoFactor, getSession, setPendingTwoFactor } from '@/lib/session';
import { MOCK_PASSWORD, MOCK_TWO_FACTOR_CODE } from '@/mocks/data/users';
import { renderWithProviders } from '@/test/render';
import { TwoFactorVerifyPage } from './two-factor-verify-page';

function renderVerifyPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.twoFactorVerify} element={<TwoFactorVerifyPage />} />
      <Route path={routes.login} element={<p>Sign-in page</p>} />
      <Route path={routes.home} element={<p>Dashboard home</p>} />
    </Routes>,
    { route: routes.twoFactorVerify },
  );
}

/** Does the password step for the admin account, like the sign-in page would. */
async function signInAsAdmin() {
  const login = await fetchClient.POST('/auth/login', {
    body: { email: 'admin@samtec.example', password: MOCK_PASSWORD },
  });
  if (login.data?.status !== 'TWO_FACTOR_REQUIRED') {
    throw new Error('Expected a two-factor challenge');
  }
  setPendingTwoFactor({ step: 'VERIFY', challengeToken: login.data.challengeToken });
}

async function enterCode(code: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('6-digit code'), code);
  await user.click(screen.getByRole('button', { name: 'Verify code' }));
}

describe('TwoFactorVerifyPage', () => {
  it('sends the user back to sign in when there is no pending challenge', async () => {
    renderVerifyPage();

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('signs the admin in with the right code', async () => {
    await signInAsAdmin();
    renderVerifyPage();

    await enterCode(MOCK_TWO_FACTOR_CODE);

    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
    expect(getSession()?.user.role).toBe('ADMIN');
    expect(getPendingTwoFactor()).toBeNull();
  });

  it('shows the API message for a wrong code', async () => {
    await signInAsAdmin();
    renderVerifyPage();

    await enterCode('000000');

    expect(await screen.findByText('The code is incorrect.')).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it('refuses a code that is not six digits without calling the API', async () => {
    await signInAsAdmin();
    renderVerifyPage();

    await enterCode('12ab');

    expect(screen.getByLabelText('6-digit code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('The code must be exactly 6 digits.')).toBeInTheDocument();
    expect(screen.queryByText('Could not continue')).not.toBeInTheDocument();
  });

  it('explains when the challenge has expired and offers to start over', async () => {
    setPendingTwoFactor({ step: 'VERIFY', challengeToken: 'mock-verify-token.expired' });
    renderVerifyPage();

    await enterCode(MOCK_TWO_FACTOR_CODE);

    expect(
      await screen.findByText('This sign-in has expired. Sign in with your password again.'),
    ).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('link', { name: 'Start over' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(getPendingTwoFactor()).toBeNull();
  });
});
