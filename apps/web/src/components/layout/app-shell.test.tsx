import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { RequireSession } from '@/components/require-session';
import { fetchClient } from '@/lib/api';
import { getSession } from '@/lib/session';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { AppShell } from './app-shell';

/** The shell as the router mounts it: inside the session guard. */
function renderShell() {
  return renderWithProviders(
    <Routes>
      <Route
        path={routes.home}
        element={
          <RequireSession>
            <AppShell />
          </RequireSession>
        }
      >
        <Route index element={<p>Home page</p>} />
      </Route>
      <Route path={routes.login} element={<p>Sign-in page</p>} />
    </Routes>,
  );
}

describe('AppShell', () => {
  it('shows who is signed in and their role', async () => {
    await signInForTests('admin@samtec.example');

    renderShell();

    expect(await screen.findByText('Efua Mensah')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('shows a supervisor the Employees link', async () => {
    await signInForTests('supervisor@samtec.example');

    renderShell();

    expect(await screen.findByRole('link', { name: 'Employees' })).toBeInTheDocument();
  });

  it('hides the Employees link from a guard, who may not list employees', async () => {
    await signInForTests('guard@samtec.example');

    renderShell();

    await screen.findByText('Kwame Kofi Mensah');
    expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sites' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'System status' })).toBeInTheDocument();
  });

  it('signs out on the API and in the dashboard, then opens the sign-in page', async () => {
    await signInForTests();
    renderShell();
    await screen.findByText('Yaw Boateng');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(getSession()).toBeNull();
    // The refresh cookie is gone on the API's side too, so no silent sign-in later.
    const refresh = await fetchClient.POST('/auth/refresh');
    expect(refresh.response.status).toBe(401);
  });
});
