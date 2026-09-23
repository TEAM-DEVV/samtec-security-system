import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { getSession } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { ChangePasswordPage, PASSWORD_CHANGED_NOTICE } from './change-password-page';
import { LoginPage } from './login-page';

/** The page plus the real sign-in page, which shows the notice afterwards. */
function renderChangePasswordPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.changePassword} element={<ChangePasswordPage />} />
      <Route path={routes.login} element={<LoginPage />} />
    </Routes>,
    { route: routes.changePassword },
  );
}

async function fillIn(current: string, next: string, repeated = next) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Type the new password again'), repeated);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  return user;
}

describe('ChangePasswordPage', () => {
  it('changes the password, ends the session everywhere, and explains on the sign-in page', async () => {
    await signInForTests('supervisor@samtec.example');
    renderChangePasswordPage();

    await fillIn(MOCK_PASSWORD, 'a brand new long password');

    expect(await screen.findByText(PASSWORD_CHANGED_NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(getSession()).toBeNull();
    // Like the real API, the mock ended the old session: no silent sign-in later.
    const refresh = await fetchClient.POST('/auth/refresh');
    expect(refresh.response.status).toBe(401);
  });

  it('shows the API message for a wrong current password', async () => {
    await signInForTests('supervisor@samtec.example');
    renderChangePasswordPage();

    await fillIn('not the password', 'a brand new long password');

    expect(await screen.findByText('Your current password is incorrect.')).toBeInTheDocument();
    expect(getSession()).not.toBeNull();
  });

  it('checks the new password on the page before sending anything', async () => {
    await signInForTests('supervisor@samtec.example');
    renderChangePasswordPage();

    await fillIn(MOCK_PASSWORD, 'short');
    expect(await screen.findByText(/Use at least 12 characters/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'a brand new long password');
    await user.clear(screen.getByLabelText('Type the new password again'));
    await user.type(screen.getByLabelText('Type the new password again'), 'something different');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('The two new passwords are not the same. Type them again.'),
    ).toBeInTheDocument();
    expect(getSession()).not.toBeNull();
  });
});
