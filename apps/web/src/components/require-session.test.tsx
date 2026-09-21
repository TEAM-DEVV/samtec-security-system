import { act, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { clearSession, getSession, markSignedInOnThisBrowser, mayHaveSession } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { server } from '@/mocks/node';
import { EmployeesPage } from '@/pages/employees-page';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { RequireSession } from './require-session';

/** Counts requests to one API path while `run` executes. */
async function countRequests(path: string, run: () => Promise<void>): Promise<number> {
  let count = 0;
  const listener = ({ request }: { request: Request }) => {
    if (new URL(request.url).pathname.endsWith(path)) {
      count += 1;
    }
  };
  server.events.on('request:start', listener);
  try {
    await run();
  } finally {
    server.events.removeListener('request:start', listener);
  }
  return count;
}

function renderGuardedPage() {
  return renderWithProviders(
    <Routes>
      <Route
        path={routes.home}
        element={
          <RequireSession>
            <p>Private page</p>
          </RequireSession>
        }
      />
      <Route path={routes.login} element={<p>Sign-in page</p>} />
    </Routes>,
  );
}

describe('RequireSession', () => {
  it('sends a first-time visitor straight to the sign-in page, without asking the API', async () => {
    const refreshes = await countRequests('/auth/refresh', async () => {
      renderGuardedPage();
      expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    });

    expect(refreshes).toBe(0);
  });

  it('treats a note with no cookie behind it as nothing: the API decides, and the note is wiped', async () => {
    // What someone gets by typing the note into DevTools: no sign-in on the API's side.
    markSignedInOnThisBrowser(true);

    const refreshes = await countRequests('/auth/refresh', async () => {
      renderGuardedPage();
      expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    });

    expect(refreshes).toBe(1);
    expect(getSession()).toBeNull();
    expect(mayHaveSession()).toBe(false);
  });

  it('does not try to restore a session after a sign-out', async () => {
    await signInForTests();
    clearSession();

    const refreshes = await countRequests('/auth/refresh', async () => {
      renderGuardedPage();
      expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    });

    expect(refreshes).toBe(0);
  });

  it('shows the page straight away when already signed in', async () => {
    await signInForTests();

    renderGuardedPage();

    expect(await screen.findByText('Private page')).toBeInTheDocument();
  });

  it('restores the session from the refresh cookie after a page reload', async () => {
    // Sign in on the API's side only: the mock now holds the "cookie", but the
    // dashboard's memory is empty, exactly like after a reload.
    await fetchClient.POST('/auth/login', {
      body: { email: 'supervisor@samtec.example', password: MOCK_PASSWORD },
    });
    // The note a real sign-in leaves behind, which survives the reload.
    markSignedInOnThisBrowser(true);
    expect(getSession()).toBeNull();

    const refreshes = await countRequests('/auth/refresh', async () => {
      renderGuardedPage();
      expect(await screen.findByText('Private page')).toBeInTheDocument();
    });

    expect(refreshes).toBe(1);
    expect(getSession()?.user.fullName).toBe('Yaw Boateng');
  });

  it('forgets everything that was loaded when the session ends', async () => {
    await signInForTests();
    const { queryClient } = renderWithProviders(
      <Routes>
        <Route
          path={routes.home}
          element={
            <RequireSession>
              <EmployeesPage />
            </RequireSession>
          }
        />
        <Route path={routes.login} element={<p>Sign-in page</p>} />
      </Routes>,
    );
    expect(await screen.findByText('Kwame Kofi Mensah')).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).not.toHaveLength(0);

    // What every kind of sign-out does, whether the button or a refused refresh.
    act(() => clearSession());

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
