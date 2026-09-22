import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { clearSession, getSession, markSignedInOnThisBrowser } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { resetMockUsers } from '@/mocks/handlers/users';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { SetPasswordPage } from './set-password-page';

afterEach(() => resetMockUsers());

/** Shows what the address bar holds, so a test can check the token was removed. */
function AddressBar() {
  const location = useLocation();
  return <output aria-label="Address">{`${location.pathname}${location.hash}`}</output>;
}

function renderSetPasswordPage(address: string, { strict = false } = {}) {
  const pages = (
    <Routes>
      <Route
        path={routes.setPassword}
        element={
          <>
            <SetPasswordPage />
            <AddressBar />
          </>
        }
      />
      <Route path={routes.login} element={<p>Sign-in page</p>} />
    </Routes>
  );
  // The real app runs in StrictMode, which runs every effect twice in development.
  return renderWithProviders(strict ? <StrictMode>{pages}</StrictMode> : pages, {
    route: address,
  });
}

/** A real one-time link from the mock API, the way an administrator makes one. */
async function newAccountLink(): Promise<string> {
  await signInForTests('admin@samtec.example');
  const { data } = await fetchClient.POST('/users', {
    body: { email: 'new.hr@samtec.example', fullName: 'New HR Officer', role: 'HR_PAYROLL' },
  });
  // The person opening the link is not signed in.
  clearSession();
  return data?.passwordSetup.token ?? '';
}

async function choose(password: string, repeated = password) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Type it again'), repeated);
  await user.click(screen.getByRole('button', { name: 'Set my password' }));
}

describe('SetPasswordPage', () => {
  it('sets the password with the link, then offers sign-in', async () => {
    const token = await newAccountLink();
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await choose('a long enough sentence');

    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Go to sign in' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('removes the token from the address bar as soon as it has read it, even in StrictMode', async () => {
    const token = await newAccountLink();
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`, { strict: true });

    expect(await screen.findByLabelText('Address')).toHaveTextContent(/^\/set-password$/);
    // The page still has the token, in memory.
    await choose('a long enough sentence');
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
  });

  it('asks someone already signed in to sign out first, then continues with the same link', async () => {
    const token = await newAccountLink();
    await signInForTests('supervisor@samtec.example');
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    expect(await screen.findByText('You are signed in')).toBeInTheDocument();
    expect(screen.getByText('Yaw Boateng')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out and continue' }));
    await choose('a long enough sentence');
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
  });

  it('after a reload, checks for a signed-in user before ever showing the form', async () => {
    const token = await newAccountLink();
    // Signed in on the API's side only, like a browser after a reload: the
    // refresh "cookie" and the signed-in note survive, the memory is empty.
    await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });
    markSignedInOnThisBrowser(true);
    expect(getSession()).toBeNull();

    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(await screen.findByText('You are signed in')).toBeInTheDocument();
    expect(screen.getByText('Yaw Boateng')).toBeInTheDocument();
  });

  it('sends the password once, however fast the button is pressed', async () => {
    const token = await newAccountLink();
    let requests = 0;
    const count = ({ request }: { request: Request }) => {
      if (new URL(request.url).pathname.endsWith('/auth/set-password')) requests += 1;
    };
    server.events.on('request:start', count);
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'a long enough sentence');
    await user.type(screen.getByLabelText('Type it again'), 'a long enough sentence');
    const button = screen.getByRole('button', { name: 'Set my password' });
    await user.dblClick(button);

    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
    server.events.removeListener('request:start', count);
    expect(requests).toBe(1);
  });

  it('refuses a link that was already used, with the API message', async () => {
    const token = await newAccountLink();
    await fetchClient.POST('/auth/set-password', {
      body: { token, newPassword: 'the first time it was used' },
    });
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await choose('a long enough sentence');

    expect(await screen.findByText('Could not set your password')).toBeInTheDocument();
    expect(screen.getByText(/expired or was already used/)).toBeInTheDocument();
  });

  it('asks for at least 12 characters before sending anything', async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);

    await choose('too short');

    expect(await screen.findByText(/Use at least 12 characters/)).toBeInTheDocument();
    expect(screen.queryByText('Could not set your password')).not.toBeInTheDocument();
  });

  it('asks again when the two passwords are not the same', async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);

    await choose('a long enough sentence', 'a different sentence');

    expect(await screen.findByText(/not the same/)).toBeInTheDocument();
    expect(screen.queryByText('Could not set your password')).not.toBeInTheDocument();
  });

  it('explains what to do when the link has no token', async () => {
    renderSetPasswordPage(routes.setPassword);

    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});
