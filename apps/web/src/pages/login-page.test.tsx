import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { env } from '@/lib/env';
import { getPendingTwoFactor, getSession } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { LoginPage } from './login-page';

/** The sign-in page plus stand-ins for the pages it sends people to. */
function renderLoginPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.login} element={<LoginPage />} />
      <Route path={routes.home} element={<p>Dashboard home</p>} />
      <Route path={routes.twoFactorVerify} element={<p>Two-factor code screen</p>} />
      <Route path={routes.twoFactorSetup} element={<p>Two-factor setup screen</p>} />
    </Routes>,
    { route: routes.login },
  );
}

async function signInAs(email: string, password = MOCK_PASSWORD) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  it('signs a supervisor in and opens the dashboard', async () => {
    renderLoginPage();

    await signInAs('supervisor@samtec.example');

    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
    expect(getSession()?.user.fullName).toBe('Yaw Boateng');
    expect(getSession()?.accessToken).toBeTruthy();
  });

  it('sends an admin to the two-factor code screen', async () => {
    renderLoginPage();

    await signInAs('admin@samtec.example');

    expect(await screen.findByText('Two-factor code screen')).toBeInTheDocument();
    expect(getPendingTwoFactor()?.step).toBe('VERIFY');
    expect(getSession()).toBeNull();
  });

  it('sends an HR user to the two-factor setup screen', async () => {
    renderLoginPage();

    await signInAs('hr@samtec.example');

    expect(await screen.findByText('Two-factor setup screen')).toBeInTheDocument();
    expect(getPendingTwoFactor()?.step).toBe('SETUP');
    expect(getSession()).toBeNull();
  });

  it('shows the API message for a wrong password and stays on the page', async () => {
    renderLoginPage();

    await signInAs('supervisor@samtec.example', 'not-the-password');

    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it('shows how long to wait after too many attempts', async () => {
    server.use(
      http.post(`${env.apiBaseUrl}/auth/login`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Too Many Requests',
            status: 429,
            detail: 'Too many attempts. Try again in 60 seconds.',
            traceId: 'trace-test-429',
          },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
      ),
    );
    renderLoginPage();

    await signInAs('supervisor@samtec.example');

    expect(
      await screen.findByText('Too many attempts. Try again in 60 seconds.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-test-429')).toBeInTheDocument();
  });
});
