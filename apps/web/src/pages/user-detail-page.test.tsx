import type { UpdateUserRequest } from '@samtec/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { env } from '@/lib/env';
import { mockAccounts } from '@/mocks/data/accounts';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { UserDetailPage } from './user-detail-page';

const ADMIN_ID = mockAccounts.find((account) => account.role === 'ADMIN')?.id ?? '';
const HR_ID = mockAccounts.find((account) => account.role === 'HR_PAYROLL')?.id ?? '';
const SUPERVISOR_ID = mockAccounts.find((account) => account.role === 'SUPERVISOR')?.id ?? '';
const NOBODY = '01927c3e-2222-7ccc-9ddd-000000000999';

function renderAccountPage(userId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/users/:userId" element={<UserDetailPage />} />
      <Route path={routes.users} element={<p>User list</p>} />
    </Routes>,
    { route: routes.user(userId) },
  );
}

describe('UserDetailPage', () => {
  it('switches an account off after asking, locks the form, then offers to switch it on', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderAccountPage(HR_ID);
    await screen.findByRole('heading', { name: 'Kofi Asante' });

    await user.click(screen.getByRole('button', { name: 'Switch off' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Switch off Kofi Asante's account\?/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }));

    expect(await screen.findByRole('button', { name: 'Switch on' })).toBeInTheDocument();
    expect(screen.getByText('Switched off')).toBeInTheDocument();
    // The API refuses changes to a switched-off account, so the form says so instead of failing.
    expect(screen.getByLabelText('Full name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByText('Switch the account on to change its details.')).toBeInTheDocument();
  });

  it('resets sign-in after asking, shows the new link, and forgets the token when the page closes', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const { queryClient, unmount } = renderAccountPage(HR_ID);
    await screen.findByRole('heading', { name: 'Kofi Asante' });

    await user.click(screen.getByRole('button', { name: 'Reset sign-in' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset sign-in' }));

    const link = await screen.findByLabelText<HTMLInputElement>('One-time password link');
    expect(link.value).toContain('/set-password#token=');
    expect(await screen.findByText('Awaiting password')).toBeInTheDocument();

    // The token lives in the page only: nothing stays behind in the data cache.
    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });

  it('saves a new name and reports it', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderAccountPage(HR_ID);
    await screen.findByRole('heading', { name: 'Kofi Asante' });

    const name = screen.getByLabelText('Full name');
    await user.clear(name);
    await user.type(name, 'Kofi A. Asante');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Kofi A. Asante' })).toBeInTheDocument();
  });

  it('sends only the fields that changed, and nothing when nothing changed', async () => {
    await signInForTests('admin@samtec.example');
    const sentBodies: UpdateUserRequest[] = [];
    server.use(
      http.patch(`${env.apiBaseUrl}/users/:userId`, async ({ request }) => {
        sentBodies.push((await request.json()) as UpdateUserRequest);
        const current = await fetchClient.GET('/users/{userId}', {
          params: { path: { userId: SUPERVISOR_ID } },
        });
        return HttpResponse.json({ ...current.data, role: 'HR_PAYROLL', employeeId: null });
      }),
    );
    const user = userEvent.setup();
    renderAccountPage(SUPERVISOR_ID);
    await screen.findByRole('heading', { name: 'Yaw Boateng' });

    // Nothing typed yet: no request at all.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Nothing to save.')).toBeInTheDocument();
    expect(sentBodies).toEqual([]);

    // A supervisor becoming HR loses the employee link: both go in one PATCH, nothing else.
    await user.selectOptions(screen.getByLabelText('Role'), 'HR_PAYROLL');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(sentBodies).toEqual([{ role: 'HR_PAYROLL', employeeId: null }]);
  });

  it('locks everything but the name on the administrator’s own account', async () => {
    await signInForTests('admin@samtec.example');
    renderAccountPage(ADMIN_ID);
    await screen.findByRole('heading', { name: 'Efua Mensah' });

    expect(screen.getByText(/this is you/)).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeEnabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Role')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Switch off' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset sign-in' })).not.toBeInTheDocument();
  });

  it('offers the confirm button to a different administrator, and never to the one who asked', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    // Promoting somebody leaves their account waiting for a second administrator.
    renderAccountPage(SUPERVISOR_ID);
    await screen.findByRole('heading', { name: 'Yaw Boateng' });
    await user.selectOptions(screen.getByLabelText('Role'), 'ADMIN');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Awaiting a second administrator')).toBeInTheDocument();

    // The administrator who made the change is told to ask somebody else.
    expect(screen.getByText(/another administrator must confirm it/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm this administrator' }),
    ).not.toBeInTheDocument();
  });

  it('lets the second administrator confirm, and the account becomes usable', async () => {
    // One administrator promotes somebody, through the API rather than the
    // screen, so the page below is opened fresh as the *other* administrator.
    await signInForTests('admin@samtec.example');
    await fetchClient.PATCH('/users/{userId}', {
      params: { path: { userId: SUPERVISOR_ID } },
      body: { role: 'ADMIN', employeeId: null },
    });

    await signInForTests('admin2@samtec.example');
    const user = userEvent.setup();
    renderAccountPage(SUPERVISOR_ID);

    const confirm = await screen.findByRole('button', { name: 'Confirm this administrator' });
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.queryByText('Awaiting a second administrator')).not.toBeInTheDocument();
    });
  });

  it('says calmly when there is no such account', async () => {
    await signInForTests('admin@samtec.example');
    renderAccountPage(NOBODY);

    expect(await screen.findByText('No account found')).toBeInTheDocument();
  });
});
