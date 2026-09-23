import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { mockAccounts } from '@/mocks/data/accounts';
import { mockEmployees } from '@/mocks/data/employees';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { NewUserPage } from './new-user-page';

/** An employee who has not left and has no sign-in account yet. */
const linkable = mockEmployees.find(
  (employee) =>
    employee.status !== 'TERMINATED' &&
    !mockAccounts.some((account) => account.employeeId === employee.id),
);

describe('NewUserPage', () => {
  it('creates a guard account linked to an employee and shows the one-time link', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const { queryClient, unmount } = renderWithProviders(<NewUserPage />);

    await user.type(screen.getByLabelText('Full name'), 'Ama Serwaa');
    await user.type(screen.getByLabelText('Email'), 'Ama.Serwaa@samtec.example');
    await user.selectOptions(screen.getByLabelText('Role'), 'GUARD');
    // The drop-down fills from the API first.
    await screen.findByRole('option', { name: /Choose an employee/ });
    await user.selectOptions(screen.getByLabelText('Linked employee'), linkable?.id ?? '');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Account created' })).toBeInTheDocument();
    // The link is built from the token, ready to send; the email is stored lower-case.
    const link = screen.getByLabelText<HTMLInputElement>('One-time password link');
    expect(link.value).toContain('/set-password#token=');
    // The lower-cased email appears in the summary and again in the link panel.
    expect(screen.getAllByText('ama.serwaa@samtec.example', { exact: false })).not.toHaveLength(0);

    // The link really works: it sets a password on the new account.
    const token = decodeURIComponent(link.value.split('#token=')[1] ?? '');
    const set = await fetchClient.POST('/auth/set-password', {
      body: { token, newPassword: 'a long enough password' },
    });
    expect(set.response.status).toBe(204);

    // The token lives in the page only: nothing stays behind in the data cache.
    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });

  it('asks for an employee before sending a guard account', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<NewUserPage />);

    await user.type(screen.getByLabelText('Full name'), 'No Link');
    await user.type(screen.getByLabelText('Email'), 'nolink@samtec.example');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('A guard account must be linked to an employee.'),
    ).toBeInTheDocument();
  });

  it('shows the API message when the email is already taken', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<NewUserPage />);

    await user.type(screen.getByLabelText('Full name'), 'Second HR');
    await user.type(screen.getByLabelText('Email'), 'hr@samtec.example');
    await user.selectOptions(screen.getByLabelText('Role'), 'HR_PAYROLL');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('An account with this email already exists.'),
    ).toBeInTheDocument();
  });
});
