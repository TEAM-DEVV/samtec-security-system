import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { StrictMode } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { clearSession, getSession, markSignedInOnThisBrowser } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { resetMockUsers } from '@/mocks/handlers/users';
import { apiUrl } from '@/mocks/helpers';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { SetPasswordPage } from './set-password-page';

afterEach(() => resetMockUsers());

const GOOD_PASSWORD = 'a long enough sentence';

/** Shows what the address bar holds, so a test can check the token was removed. */
function AddressBar() {
  const location = useLocation();
  return <output aria-label="Address">{`${location.pathname}${location.hash}`}</output>;
}

/** Stands in for pasting a new link into the same tab: the page stays mounted. */
function PasteLink({ token }: { token: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`${routes.setPassword}#token=${token}`)}>
      Paste another link
    </button>
  );
}

function renderSetPasswordPage(
  address: string,
  { strict = false, pasteToken = '' }: { strict?: boolean; pasteToken?: string } = {},
) {
  const pages = (
    <Routes>
      <Route
        path={routes.setPassword}
        element={
          <>
            <SetPasswordPage />
            <AddressBar />
            {pasteToken && <PasteLink token={pasteToken} />}
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
async function newAccountLink(email = 'new.hr@samtec.example'): Promise<string> {
  await signInForTests('admin@samtec.example');
  const { data } = await fetchClient.POST('/users', {
    body: { email, fullName: 'New HR Officer', role: 'HR_PAYROLL' },
  });
  // The person opening the link is not signed in.
  clearSession();
  return data?.passwordSetup.token ?? '';
}

/** Counts the requests to one API path while `work` runs. */
async function countRequests(path: string, work: () => Promise<void>): Promise<number> {
  let count = 0;
  const listener = ({ request }: { request: Request }) => {
    if (new URL(request.url).pathname.endsWith(path)) count += 1;
  };
  server.events.on('request:start', listener);
  try {
    await work();
  } finally {
    server.events.removeListener('request:start', listener);
  }
  return count;
}

async function choose(password: string, repeated = password) {
  const user = userEvent.setup();
  if (password) await user.type(screen.getByLabelText('New password'), password);
  if (repeated) await user.type(screen.getByLabelText('Type it again'), repeated);
  await user.click(screen.getByRole('button', { name: 'Set my password' }));
}

describe('SetPasswordPage', () => {
  it('sets the password with the link, keeps it out of every cache, then offers sign-in', async () => {
    const token = await newAccountLink();
    const { queryClient } = renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await choose(GOOD_PASSWORD);

    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state),
      ),
    ).not.toContain(GOOD_PASSWORD);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Go to sign in' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('removes the token from the address bar, even in StrictMode', async () => {
    const token = await newAccountLink();
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`, { strict: true });

    expect(await screen.findByLabelText('Address')).toHaveTextContent(/^\/set-password$/);
    // The page still has the token, in memory.
    await choose(GOOD_PASSWORD);
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
  });

  it('asks someone signed in to sign out first, signs them out, then uses the same link', async () => {
    const token = await newAccountLink();
    await signInForTests('supervisor@samtec.example');
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    expect(await screen.findByText('You are signed in')).toBeInTheDocument();
    expect(screen.getByText('Yaw Boateng')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();

    const logouts = await countRequests('/auth/logout', async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out and continue' }));
      // Keyboard focus moves to the form that appears.
      expect(await screen.findByLabelText('New password')).toHaveFocus();
    });
    expect(logouts).toBe(1);
    expect(getSession()).toBeNull();

    await choose(GOOD_PASSWORD);
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
  });

  it('still continues when signing out cannot reach the API', async () => {
    const token = await newAccountLink();
    await signInForTests('supervisor@samtec.example');
    server.use(http.post(apiUrl('/auth/logout'), () => new HttpResponse(null, { status: 500 })));
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Sign out and continue' }));

    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
    expect(getSession()).toBeNull();
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

    renderSetPasswordPage(`${routes.setPassword}#token=${token}`, { strict: true });

    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(await screen.findByText('You are signed in')).toBeInTheDocument();
    expect(screen.getByText('Yaw Boateng')).toBeInTheDocument();
  });

  it('keeps the form hidden when the sign-in check gets no answer', async () => {
    const token = await newAccountLink();
    markSignedInOnThisBrowser(true);
    server.use(http.post(apiUrl('/auth/refresh'), () => new HttpResponse(null, { status: 503 })));

    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    expect(await screen.findByText('Could not check this browser')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();

    // Signing out is a clear answer: the form comes back.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out and continue' }));
    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
  });

  it('refuses a link that was already used, with the API message', async () => {
    const token = await newAccountLink();
    await fetchClient.POST('/auth/set-password', {
      body: { token, newPassword: 'the first time it was used' },
    });
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await choose(GOOD_PASSWORD);

    expect(await screen.findByText('Could not set your password')).toBeInTheDocument();
    expect(screen.getByText(/expired or was already used/)).toBeInTheDocument();
  });

  it('never claims success when the answer is an error without a body', async () => {
    const token = await newAccountLink();
    server.use(
      http.post(apiUrl('/auth/set-password'), () => new HttpResponse(null, { status: 503 })),
    );
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);

    await choose(GOOD_PASSWORD);

    expect(await screen.findByText('Could not set your password')).toBeInTheDocument();
    expect(screen.queryByText('Your password is set')).not.toBeInTheDocument();
    // What was typed is kept, so trying again is one click.
    expect(screen.getByLabelText('New password')).toHaveValue(GOOD_PASSWORD);
  });

  it('asks for at least 12 characters, marks the field and sends nothing', async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);

    const sent = await countRequests('/auth/set-password', () => choose('too short'));

    expect(await screen.findByText(/Use at least 12 characters/)).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('New password')).toHaveFocus();
    expect(sent).toBe(0);
  });

  it("uses the page's own message for empty fields, not the browser's", async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);

    const sent = await countRequests('/auth/set-password', () => choose('', ''));

    expect(await screen.findByText(/Use at least 12 characters/)).toBeInTheDocument();
    expect(sent).toBe(0);
  });

  it('refuses more than 128 characters, even when a password manager fills the field', async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);
    const tooLong = 'x'.repeat(129);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: tooLong } });
    fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: tooLong } });

    const sent = await countRequests('/auth/set-password', async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Set my password' }));
    });

    expect(await screen.findByText(/at most 128 characters/)).toBeInTheDocument();
    expect(sent).toBe(0);
  });

  it('asks again when the two passwords are not the same', async () => {
    renderSetPasswordPage(`${routes.setPassword}#token=any-token`);

    await choose(GOOD_PASSWORD, 'a different sentence');

    expect(await screen.findByText(/not the same/)).toBeInTheDocument();
    expect(screen.getByLabelText('Type it again')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Could not set your password')).not.toBeInTheDocument();
  });

  it('sends the password once, even when submitted twice at the same moment', async () => {
    const token = await newAccountLink();
    renderSetPasswordPage(`${routes.setPassword}#token=${token}`);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Type it again'), GOOD_PASSWORD);
    const form = screen.getByLabelText('New password').closest('form') as HTMLFormElement;

    const sent = await countRequests('/auth/set-password', async () => {
      act(() => {
        fireEvent.submit(form);
        fireEvent.submit(form);
      });
      expect(await screen.findByText('Your password is set')).toBeInTheDocument();
    });

    expect(sent).toBe(1);
  });

  it('explains what to do when the link has no token', async () => {
    renderSetPasswordPage(routes.setPassword);

    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('takes a new link pasted into the same tab', async () => {
    const token = await newAccountLink();
    renderSetPasswordPage(routes.setPassword, { pasteToken: token });
    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Paste another link' }));

    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveTextContent(/^\/set-password$/);
    await choose(GOOD_PASSWORD);
    expect(await screen.findByText('Your password is set')).toBeInTheDocument();
  });
});
