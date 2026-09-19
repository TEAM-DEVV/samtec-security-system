import { act, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { clearSession, getSession } from '@/lib/session';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { EmployeesPage } from '@/pages/employees-page';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { RequireSession } from './require-session';

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
  it('sends a visitor with no session to the sign-in page', async () => {
    renderGuardedPage();

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
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
    expect(getSession()).toBeNull();

    renderGuardedPage();

    expect(await screen.findByText('Private page')).toBeInTheDocument();
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
